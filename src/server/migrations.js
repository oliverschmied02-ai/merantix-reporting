import bcrypt from 'bcrypt';
import { pool } from './db.js';
import { log } from './logger.js';

// ── DB MIGRATIONS ─────────────────────────────────────────────────────
// Each migration runs exactly once, tracked by version number in schema_migrations.
const MIGRATIONS = [
  {
    version: 1,
    description: 'Initial schema',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        name          TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT DEFAULT 'viewer',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS gdpdu_files (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        company_name TEXT,
        uploaded_by  INTEGER REFERENCES users(id),
        uploaded_at  TIMESTAMPTZ DEFAULT NOW(),
        txn_count    INTEGER,
        years        JSONB
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id         SERIAL PRIMARY KEY,
        file_id    TEXT REFERENCES gdpdu_files(id) ON DELETE CASCADE,
        ktonr      INTEGER,
        gktonr     INTEGER,
        soll       NUMERIC,
        haben      NUMERIC,
        datum      DATE,
        text       TEXT,
        beleg      TEXT,
        wj_month   INTEGER,
        wj_year    INTEGER,
        stapel_raw TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_txn_file ON transactions(file_id);
      CREATE INDEX IF NOT EXISTS idx_txn_year ON transactions(wj_year);
      CREATE TABLE IF NOT EXISTS account_names (
        ktonr INTEGER PRIMARY KEY,
        name  TEXT
      );
      CREATE TABLE IF NOT EXISTS direct_mappings (
        txn_id  INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        sub_id  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS access_requests (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        email      TEXT NOT NULL,
        message    TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `,
  },
  {
    version: 2,
    description: 'Add role column to users (idempotent for existing installs)',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'viewer';
          UPDATE users SET role='admin' WHERE id=(SELECT MIN(id) FROM users) AND role IS NULL;`,
  },
  {
    version: 3,
    description: 'Add audit_log table',
    sql: `
      CREATE TABLE IF NOT EXISTS audit_log (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action     TEXT NOT NULL,
        detail     TEXT,
        ip         TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
    `,
  },
  {
    version: 4,
    description: 'Add user_settings table for per-user CoA and rules persistence',
    sql: `
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key        TEXT NOT NULL,
        value      JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, key)
      );
    `,
  },
  {
    version: 5,
    description: 'Add content_hash column to gdpdu_files for duplicate detection',
    sql: `ALTER TABLE gdpdu_files ADD COLUMN IF NOT EXISTS content_hash TEXT;
          CREATE INDEX IF NOT EXISTS idx_gdpdu_hash ON gdpdu_files(content_hash);`,
  },
  {
    version: 6,
    description: 'Planning module: plan_versions, plan_entries, plan_assumptions',
    sql: `
      -- A named planning scenario/version (e.g. "Budget 2025", "Forecast Q3")
      CREATE TABLE IF NOT EXISTS plan_versions (
        id          SERIAL PRIMARY KEY,
        name        TEXT        NOT NULL,
        year        INTEGER     NOT NULL,
        type        TEXT        NOT NULL DEFAULT 'budget'
                    CHECK (type IN ('budget','forecast','scenario')),
        notes       TEXT,
        created_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_at   TIMESTAMPTZ,
        locked_by   INTEGER     REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pv_year ON plan_versions(year);

      -- Monthly planned amounts per line item per version.
      -- item_id matches APP.plDef[].id (e.g. 'revenue', 'personnel').
      -- amount sign convention: positive = income-side, negative = cost-side.
      CREATE TABLE IF NOT EXISTS plan_entries (
        id          SERIAL PRIMARY KEY,
        version_id  INTEGER     NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
        item_id     TEXT        NOT NULL,
        month       INTEGER     NOT NULL CHECK (month BETWEEN 1 AND 12),
        year        INTEGER     NOT NULL,
        amount      NUMERIC     NOT NULL DEFAULT 0,
        note        TEXT,
        updated_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (version_id, item_id, month, year)
      );
      CREATE INDEX IF NOT EXISTS idx_pe_version ON plan_entries(version_id);
      CREATE INDEX IF NOT EXISTS idx_pe_item    ON plan_entries(item_id);

      -- Named assumptions attached to a version (e.g. "Headcount: 12 FTE").
      CREATE TABLE IF NOT EXISTS plan_assumptions (
        id          SERIAL PRIMARY KEY,
        version_id  INTEGER     NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
        label       TEXT        NOT NULL,
        value       TEXT        NOT NULL DEFAULT '',
        note        TEXT,
        sort_order  INTEGER     NOT NULL DEFAULT 0,
        updated_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pa_version ON plan_assumptions(version_id);
    `,
  },
  {
    version: 7,
    description: 'Planning: plan_line_items with finance categorization + FK on plan_entries',
    sql: `
      -- Granular planning rows within a version.
      -- Each line item maps to one plDef item_id for P&L rollup.
      -- All dimensional columns are optional free-text in v1.
      CREATE TABLE IF NOT EXISTS plan_line_items (
        id           SERIAL PRIMARY KEY,
        version_id   INTEGER     NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
        label        TEXT        NOT NULL,
        item_id      TEXT        NOT NULL,
        category     TEXT        NOT NULL DEFAULT 'depreciation'
                     CHECK (category IN ('revenue','personnel','opex','allocation','other','depreciation')),
        entity       TEXT,
        fund_ref     TEXT,
        department   TEXT,
        counterparty TEXT,
        notes        TEXT,
        sort_order   INTEGER     NOT NULL DEFAULT 0,
        is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
        created_by   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pli_version  ON plan_line_items(version_id);
      CREATE INDEX IF NOT EXISTS idx_pli_item     ON plan_line_items(item_id);
      CREATE INDEX IF NOT EXISTS idx_pli_category ON plan_line_items(category);

      -- Add nullable FK from plan_entries to plan_line_items.
      -- Existing entries (line_item_id IS NULL) remain valid.
      ALTER TABLE plan_entries
        ADD COLUMN IF NOT EXISTS line_item_id INTEGER
          REFERENCES plan_line_items(id) ON DELETE CASCADE;

      -- New uniqueness constraint for line-item-scoped entries.
      -- The original UNIQUE (version_id, item_id, month, year) is kept for legacy entries.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pe_li_unique
        ON plan_entries(version_id, line_item_id, month)
        WHERE line_item_id IS NOT NULL;
    `,
  },
  {
    version: 8,
    description: 'Revenue drivers: plan_revenue_drivers + is_manual_override on plan_entries',
    sql: `
      -- Typed revenue assumption attached to a plan_line_item.
      -- The spreading engine reads this and generates plan_entries rows.
      -- driver_type:
      --   annual_fee   — total annual amount spread evenly over active months
      --   monthly_flat — fixed amount per active month (no spreading needed)
      --   one_off      — single amount placed in a specific month
      CREATE TABLE IF NOT EXISTS plan_revenue_drivers (
        id            SERIAL PRIMARY KEY,
        line_item_id  INTEGER     NOT NULL REFERENCES plan_line_items(id) ON DELETE CASCADE,
        driver_type   TEXT        NOT NULL DEFAULT 'annual_fee'
                      CHECK (driver_type IN ('annual_fee','monthly_flat','one_off')),
        amount        NUMERIC     NOT NULL,
        -- Date range within the plan year (inclusive).
        -- NULL start = first day of plan year. NULL end = last day of plan year.
        start_date    DATE,
        end_date      DATE,
        -- Spreading method. 'even' = equal share per full or partial calendar month.
        -- 'custom' reserved for future weighted spreading.
        spread_method TEXT        NOT NULL DEFAULT 'even'
                      CHECK (spread_method IN ('even','custom')),
        notes         TEXT,
        created_by    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_prd_line_item ON plan_revenue_drivers(line_item_id);

      -- Flag set when a user manually edits a generated entry.
      -- The generate endpoint skips months where this is TRUE.
      ALTER TABLE plan_entries
        ADD COLUMN IF NOT EXISTS is_manual_override BOOLEAN NOT NULL DEFAULT FALSE;
    `,
  },
  {
    version: 9,
    description: 'Personnel planning: plan_personnel_drivers',
    sql: `
      -- One row per employee or planned hire within a plan version.
      -- Links to a plan_line_item with category='personnel'.
      -- The spreading engine produces monthly gross + burden entries.
      --
      -- Partial month rule: start/end months are prorated by calendar days.
      -- Salary increase: new salary applies from salary_increase_date onward.
      -- Bonus: placed as a lump sum in bonus_month (1-12), only if active.
      CREATE TABLE IF NOT EXISTS plan_personnel_drivers (
        id                    SERIAL PRIMARY KEY,
        line_item_id          INTEGER     NOT NULL REFERENCES plan_line_items(id) ON DELETE CASCADE,

        -- Identity
        employee_name         TEXT        NOT NULL,
        role_title            TEXT,
        department            TEXT,
        is_filled             BOOLEAN     NOT NULL DEFAULT TRUE,
        -- FALSE = open / planned hire (headcount placeholder)

        -- Employment dates (NULL = full year)
        start_date            DATE,
        end_date              DATE,

        -- Compensation
        annual_gross_salary   NUMERIC     NOT NULL,
        -- Employer social charges / payroll burden as a decimal (e.g. 0.20 = 20%)
        payroll_burden_rate   NUMERIC     NOT NULL DEFAULT 0,

        -- Salary increase mid-year
        salary_increase_date  DATE,
        annual_gross_salary_post_increase NUMERIC,

        -- Bonus (annual lump sum placed in bonus_month)
        annual_bonus          NUMERIC     NOT NULL DEFAULT 0,
        bonus_month           INTEGER     NOT NULL DEFAULT 12
                              CHECK (bonus_month BETWEEN 1 AND 12),

        notes                 TEXT,
        created_by            INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by            INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ppd_line_item ON plan_personnel_drivers(line_item_id);
    `,
  },
  {
    version: 10,
    description: 'Opex planning: add quarterly_flat driver type and vendor/recurrence columns',
    sql: `
      -- Extend driver_type CHECK to include quarterly_flat for opex use cases.
      ALTER TABLE plan_revenue_drivers
        DROP CONSTRAINT IF EXISTS plan_revenue_drivers_driver_type_check;
      ALTER TABLE plan_revenue_drivers
        ADD CONSTRAINT plan_revenue_drivers_driver_type_check
        CHECK (driver_type IN ('annual_fee','monthly_flat','one_off','quarterly_flat'));

      -- Optional vendor reference and recurrence label for opex line items.
      ALTER TABLE plan_revenue_drivers
        ADD COLUMN IF NOT EXISTS vendor TEXT,
        ADD COLUMN IF NOT EXISTS recurrence TEXT;
    `,
  },
  {
    version: 11,
    description: 'Cost allocation: plan_allocation_rules, plan_allocation_targets, plan_allocation_results',
    sql: `
      -- An allocation rule distributes one source line item's monthly amounts
      -- across named targets (entities, funds, cost centers).
      --
      -- method:
      --   fixed_pct   — each target has an explicit pct_share (0–100); must sum ≤ 100
      --   equal_split — source / n_targets per month, equal share, no pct_share needed
      --   manual      — amounts entered explicitly per target per month
      CREATE TABLE IF NOT EXISTS plan_allocation_rules (
        id                   SERIAL PRIMARY KEY,
        version_id           INTEGER     NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
        label                TEXT        NOT NULL,
        source_line_item_id  INTEGER     NOT NULL REFERENCES plan_line_items(id) ON DELETE CASCADE,
        method               TEXT        NOT NULL DEFAULT 'fixed_pct'
                             CHECK (method IN ('fixed_pct','equal_split','manual')),
        notes                TEXT,
        is_active            BOOLEAN     NOT NULL DEFAULT TRUE,
        created_by           INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by           INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_par_version ON plan_allocation_rules(version_id);
      CREATE INDEX IF NOT EXISTS idx_par_source  ON plan_allocation_rules(source_line_item_id);

      -- One row per allocation target within a rule.
      -- label: human-readable name ("Fund I", "Merantix AG")
      -- pct_share: required for fixed_pct (0–100); ignored for equal_split and manual
      CREATE TABLE IF NOT EXISTS plan_allocation_targets (
        id           SERIAL PRIMARY KEY,
        rule_id      INTEGER     NOT NULL REFERENCES plan_allocation_rules(id) ON DELETE CASCADE,
        label        TEXT        NOT NULL,
        entity       TEXT,
        fund_ref     TEXT,
        pct_share    NUMERIC,
        sort_order   INTEGER     NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_pat_rule ON plan_allocation_targets(rule_id);

      -- Generated or manually entered monthly allocation amounts per target.
      -- source_amount is a snapshot of the source line item's amount at generate time.
      -- Preserving source_amount enables audit: you always see what was allocated from what.
      CREATE TABLE IF NOT EXISTS plan_allocation_results (
        id                SERIAL PRIMARY KEY,
        rule_id           INTEGER     NOT NULL REFERENCES plan_allocation_rules(id) ON DELETE CASCADE,
        target_id         INTEGER     NOT NULL REFERENCES plan_allocation_targets(id) ON DELETE CASCADE,
        month             INTEGER     NOT NULL CHECK (month BETWEEN 1 AND 12),
        year              INTEGER     NOT NULL,
        source_amount     NUMERIC     NOT NULL DEFAULT 0,
        allocated_amount  NUMERIC     NOT NULL DEFAULT 0,
        is_manual         BOOLEAN     NOT NULL DEFAULT FALSE,
        updated_by        INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (rule_id, target_id, month, year)
      );
      CREATE INDEX IF NOT EXISTS idx_palloc_rule   ON plan_allocation_results(rule_id);
      CREATE INDEX IF NOT EXISTS idx_palloc_target ON plan_allocation_results(target_id);
    `,
  },
  {
    version: 12,
    description: 'management_fee driver type: commitment + fee_pct columns, extend CHECK constraint',
    sql: `
      ALTER TABLE plan_revenue_drivers
        DROP CONSTRAINT IF EXISTS plan_revenue_drivers_driver_type_check;
      ALTER TABLE plan_revenue_drivers
        ADD CONSTRAINT plan_revenue_drivers_driver_type_check
        CHECK (driver_type IN ('annual_fee','monthly_flat','one_off','quarterly_flat','management_fee'));
      ALTER TABLE plan_revenue_drivers
        ADD COLUMN IF NOT EXISTS commitment NUMERIC,
        ADD COLUMN IF NOT EXISTS fee_pct    NUMERIC;
    `,
  },
  {
    version: 13,
    description: 'Drop obsolete plan_entries unique constraint; add country to personnel; tighten category CHECK',
    sql: `
      ALTER TABLE plan_entries
        DROP CONSTRAINT IF EXISTS plan_entries_version_id_item_id_month_year_key;
      ALTER TABLE plan_personnel_drivers
        ADD COLUMN IF NOT EXISTS country TEXT;
      UPDATE plan_line_items SET category = 'other' WHERE category = 'allocation';
      ALTER TABLE plan_line_items
        DROP CONSTRAINT IF EXISTS plan_line_items_category_check;
      ALTER TABLE plan_line_items
        ADD CONSTRAINT plan_line_items_category_check
        CHECK (category IN ('revenue','personnel','opex','other'));
    `,
  },
  {
    version: 14,
    description: 'Replace other category with depreciation',
    sql: `
      UPDATE plan_line_items SET category = 'depreciation' WHERE category = 'other';
      ALTER TABLE plan_line_items
        DROP CONSTRAINT IF EXISTS plan_line_items_category_check;
      ALTER TABLE plan_line_items
        ADD CONSTRAINT plan_line_items_category_check
        CHECK (category IN ('revenue','personnel','opex','depreciation'));
    `,
  },
];

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT,
      applied_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map(r => r.version));

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, description) VALUES ($1, $2)',
        [m.version, m.description]
      );
      await client.query('COMMIT');
      log.info({ migration: m.version }, `Migration applied: ${m.description}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${m.version} failed: ${e.message}`);
    } finally {
      client.release();
    }
  }
}

async function initDB() {
  await runMigrations();

  // Create initial admin from env vars if no users exist yet
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(rows[0].count) === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
    await pool.query(
      'INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4)',
      [process.env.ADMIN_EMAIL, process.env.ADMIN_NAME || 'Admin', hash, 'admin']
    );
    log.info({ email: process.env.ADMIN_EMAIL }, 'Initial admin user created');
  }
}

export { initDB };
