import express from 'express';
import pg from 'pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import { spreadDrivers } from './src/lib/plan-revenue.js';
import { spreadPersonnelDrivers } from './src/lib/plan-personnel.js';
import { allocate } from './src/lib/plan-allocation.js';

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV !== 'production' ? { transport: { target: 'pino-pretty' } } : {}),
});

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;
if (!process.env.JWT_SECRET) {
  log.fatal('JWT_SECRET environment variable is not set');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

function buildSslConfig() {
  if (!process.env.DATABASE_URL) return false;
  if (process.env.DATABASE_SSL_CA) {
    return { rejectUnauthorized: true, ca: process.env.DATABASE_SSL_CA };
  }
  if (process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'false') {
    log.warn('DATABASE_SSL_REJECT_UNAUTHORIZED=false — TLS certificate validation is disabled');
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: buildSslConfig(),
});

app.use(helmet({
  // CSP disabled: the app uses inline onclick handlers and Vite module scripts
  // extensively. A meaningful CSP requires migrating all onclick to event
  // delegation + nonce-based script loading — tracked as future work.
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  // All other helmet defaults remain: HSTS, X-Frame-Options: DENY,
  // X-Content-Type-Options: nosniff, Referrer-Policy, X-DNS-Prefetch-Control
}));
app.use(express.json({ limit: '100mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'dist')));
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api') || req.path === '/health') {
      log.info({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
    }
  });
  next();
});

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
        category     TEXT        NOT NULL DEFAULT 'other'
                     CHECK (category IN ('revenue','personnel','opex','allocation','other')),
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
      ALTER TABLE plan_line_items
        DROP CONSTRAINT IF EXISTS plan_line_items_category_check;
      ALTER TABLE plan_line_items
        ADD CONSTRAINT plan_line_items_category_check
        CHECK (category IN ('revenue','personnel','opex','other'));
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

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────
const COOKIE_NAME = 'gdpdu_session';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME] ?? req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token expired or invalid' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Keine Berechtigung' });
  next();
}

const MIN_PASSWORD_LENGTH = 12;
function validatePassword(password) {
  if (!password || password.length < MIN_PASSWORD_LENGTH)
    return `Passwort zu kurz (min. ${MIN_PASSWORD_LENGTH} Zeichen)`;
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmail(email) {
  if (!email || !EMAIL_RE.test(email)) return 'Ungültige E-Mail-Adresse';
  return null;
}

function logAudit(userId, action, detail, req) {
  const ip = req?.headers?.['x-forwarded-for']?.split(',')[0].trim() ?? req?.socket?.remoteAddress ?? null;
  pool.query(
    'INSERT INTO audit_log (user_id, action, detail, ip) VALUES ($1, $2, $3, $4)',
    [userId ?? null, action, detail ?? null, ip]
  ).catch(err => log.error({ err: err.message }, 'Audit log write failed'));
}

// ── HEALTH ────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', uptime: Math.floor(process.uptime()) });
  } catch (e) {
    log.error({ err: e.message }, 'Health check DB failure');
    res.status(503).json({ status: 'error', db: 'unavailable', uptime: Math.floor(process.uptime()) });
  }
});

// ── AUTH ROUTES ───────────────────────────────────────────────────────
// Authenticated API limiter: 300 req/min per user, applied after requireAuth sets req.user.
// Used on all data/mapping/user-management routes so bulk operations can't hammer the DB.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `user_${req.user.id}`,
  message: { error: 'Zu viele Anfragen. Bitte kurz warten.' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.' },
});

const requestAccessLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen von dieser IP. Bitte später erneut versuchen.' },
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email?.toLowerCase()]);
    const user = rows[0];
    if (!user || !await bcrypt.compare(password, user.password_hash)) {
      return res.status(401).json({ error: 'Email oder Passwort falsch' });
    }
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    logAudit(user.id, 'login', user.email, req);
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTS, maxAge: 0 });
  res.json({ ok: true });
});

// ── ACCESS REQUESTS (public) ──────────────────────────────────────────
app.post('/api/auth/request-access', requestAccessLimiter, async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name und E-Mail erforderlich' });
    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: emailErr });
    // Check if email already exists as user
    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(400).json({ error: 'E-Mail bereits registriert' });
    // Check if request already pending
    const pending = await pool.query('SELECT id FROM access_requests WHERE email=$1', [email.toLowerCase()]);
    if (pending.rows.length) return res.status(400).json({ error: 'Anfrage bereits gestellt' });
    await pool.query(
      'INSERT INTO access_requests (name, email, message) VALUES ($1, $2, $3)',
      [name, email.toLowerCase(), message || null]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Apply per-user rate limit to all routes below (all require authentication).
app.use('/api', requireAuth, apiLimiter);

app.get('/api/users/requests', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM access_requests ORDER BY created_at DESC');
  res.json(rows);
});

app.post('/api/users/requests/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM access_requests WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Anfrage nicht gefunden' });
    const req_ = rows[0];
    // Generate temp password
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const tempPassword = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const hash = await bcrypt.hash(tempPassword, 10);
    const ins = await pool.query(
      'INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name',
      [req_.email, req_.name, hash, 'viewer']
    );
    await pool.query('DELETE FROM access_requests WHERE id=$1', [req.params.id]);
    logAudit(req.user.id, 'access_request.approve', `email=${req_.email}`, req);
    res.json({ user: ins.rows[0], tempPassword });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('unique') ? 'E-Mail bereits registriert' : e.message });
  }
});

app.delete('/api/users/requests/:id', requireAuth, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM access_requests WHERE id=$1', [req.params.id]);
  logAudit(req.user.id, 'access_request.reject', `request_id=${req.params.id}`, req);
  res.json({ ok: true });
});

// ── USER MANAGEMENT ───────────────────────────────────────────────────
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id, email, name, role, created_at FROM users ORDER BY id');
  res.json(rows);
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, name, password, role } = req.body;
    if (!email || !name || !password) return res.status(400).json({ error: 'email, name, password required' });
    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: emailErr });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role',
      [email.toLowerCase(), name, hash, role === 'admin' ? 'admin' : 'viewer']
    );
    logAudit(req.user.id, 'user.create', `email=${email} role=${rows[0].role}`, req);
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: e.message.includes('unique') ? 'Email bereits vergeben' : e.message });
  }
});

// Own password change — any authenticated user
app.patch('/api/auth/me/password', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    logAudit(req.user.id, 'user.password_change', 'self', req);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: reset any user's password
app.patch('/api/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
    logAudit(req.user.id, 'user.password_reset', `target_user_id=${req.params.id}`, req);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: update user role
app.patch('/api/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot change your own role' });
    await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, req.params.id]);
    logAudit(req.user.id, 'user.role_change', `target_user_id=${req.params.id} role=${role}`, req);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  logAudit(req.user.id, 'user.delete', `target_user_id=${req.params.id}`, req);
  res.json({ ok: true });
});

// ── USER SETTINGS (CoA / Rules persistence) ──────────────────────────
app.get('/api/settings/:key', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT value FROM user_settings WHERE user_id=$1 AND key=$2',
    [req.user.id, req.params.key]
  );
  res.json(rows.length ? rows[0].value : null);
});

app.put('/api/settings/:key', requireAuth, async (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  await pool.query(
    `INSERT INTO user_settings (user_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, key) DO UPDATE SET value=$3, updated_at=NOW()`,
    [req.user.id, req.params.key, JSON.stringify(value)]
  );
  res.json({ ok: true });
});

// ── DATA: CHECK HASH ──────────────────────────────────────────────────
app.get('/api/data/check-hash/:hash', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name FROM gdpdu_files WHERE content_hash=$1',
    [req.params.hash]
  );
  res.json(rows.length ? { duplicate: true, file: rows[0] } : { duplicate: false });
});

// ── DATA: METADATA ONLY (no transactions) ────────────────────────────
app.get('/api/data/meta', requireAuth, async (req, res) => {
  try {
    const files = await pool.query(
      'SELECT gf.*, u.name as uploader_name FROM gdpdu_files gf LEFT JOIN users u ON gf.uploaded_by = u.id ORDER BY gf.uploaded_at'
    );
    if (files.rows.length === 0) return res.json(null);
    const accts = await pool.query('SELECT * FROM account_names');
    res.json({
      loadedFiles: files.rows.map(f => ({
        id:          f.id,
        name:        f.name,
        companyName: f.company_name || '',
        uploadedAt:  f.uploaded_at,
        txnCount:    f.txn_count,
        years:       f.years,
        uploadedBy:  f.uploader_name || '',
      })),
      accountNames: accts.rows.map(r => [r.ktonr, r.name]),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DATA: LOAD ALL (transactions, optionally filtered by year) ────────
app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const files = await pool.query(
      'SELECT gf.*, u.name as uploader_name FROM gdpdu_files gf LEFT JOIN users u ON gf.uploaded_by = u.id ORDER BY gf.uploaded_at'
    );
    if (files.rows.length === 0) return res.json(null);

    // If a specific year is requested, return transactions for that year only
    const year = req.query.year ? parseInt(req.query.year) : null;
    let txnsQuery, txnsParams;
    if (year) {
      txnsQuery  = `SELECT t.*, dm.item_id AS dm_item_id, dm.sub_id AS dm_sub_id
                    FROM transactions t
                    LEFT JOIN direct_mappings dm ON dm.txn_id = t.id
                    WHERE t.wj_year = $1
                    ORDER BY t.id`;
      txnsParams = [year];
    } else {
      txnsQuery  = `SELECT t.*, dm.item_id AS dm_item_id, dm.sub_id AS dm_sub_id
                    FROM transactions t
                    LEFT JOIN direct_mappings dm ON dm.txn_id = t.id
                    ORDER BY t.id`;
      txnsParams = [];
    }
    const txns   = await pool.query(txnsQuery, txnsParams);
    const accts  = await pool.query('SELECT * FROM account_names');

    res.json({
      loadedFiles: files.rows.map(f => ({
        id:          f.id,
        name:        f.name,
        companyName: f.company_name || '',
        uploadedAt:  f.uploaded_at,
        txnCount:    f.txn_count,
        years:       f.years,
        uploadedBy:  f.uploader_name || '',
      })),
      transactions: txns.rows.map(t => ({
        _dbId:      t.id,
        ktonr:      t.ktonr,
        gktonr:     t.gktonr,
        soll:       parseFloat(t.soll),
        haben:      parseFloat(t.haben),
        datum:      t.datum ? new Date(t.datum) : null,
        text:       t.text,
        beleg:      t.beleg,
        wjMonth:    t.wj_month,
        wjYear:     t.wj_year,
        stapelRaw:  t.stapel_raw,
        _fileId:    t.file_id,
        ...(t.dm_item_id ? { _directMapping: { itemId: t.dm_item_id, subId: t.dm_sub_id } } : {}),
      })),
      accountNames: accts.rows.map(r => [r.ktonr, r.name]),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DATA: SAVE NEW FILE ───────────────────────────────────────────────
app.post('/api/data', requireAuth, async (req, res) => {
  const { file, transactions, accountNames } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO gdpdu_files (id, name, company_name, uploaded_by, uploaded_at, txn_count, years, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [file.id, file.name, file.companyName || null, req.user.id, file.uploadedAt, file.txnCount, JSON.stringify(file.years), file.contentHash || null]
    );

    // Batch insert transactions (500 rows per query to stay under param limits)
    const BATCH = 500;
    for (let i = 0; i < transactions.length; i += BATCH) {
      const batch = transactions.slice(i, i + BATCH);
      const vals  = batch.map((_, j) => {
        const b = j * 11;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`;
      }).join(',');
      const params = batch.flatMap(t => [
        file.id, t.ktonr, t.gktonr ?? null, t.soll, t.haben,
        t.datum ?? null, t.text ?? null, t.beleg ?? null,
        t.wjMonth ?? null, t.wjYear ?? null, t.stapelRaw ?? null,
      ]);
      await client.query(
        `INSERT INTO transactions (file_id,ktonr,gktonr,soll,haben,datum,text,beleg,wj_month,wj_year,stapel_raw) VALUES ${vals}`,
        params
      );
    }

    // Upsert account names
    for (const [ktonr, name] of (accountNames || [])) {
      await client.query(
        'INSERT INTO account_names (ktonr, name) VALUES ($1,$2) ON CONFLICT (ktonr) DO UPDATE SET name=$2',
        [ktonr, name]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── DATA: DELETE ONE FILE ─────────────────────────────────────────────
app.delete('/api/data/:fileId', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM gdpdu_files WHERE id = $1', [req.params.fileId]);
  logAudit(req.user.id, 'data.delete_file', `file_id=${req.params.fileId}`, req);
  res.json({ ok: true });
});

// ── DATA: CLEAR ALL ───────────────────────────────────────────────────
app.delete('/api/data', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM gdpdu_files'); // cascades to transactions
  await pool.query('DELETE FROM account_names');
  logAudit(req.user.id, 'data.clear_all', null, req);
  res.json({ ok: true });
});

// ── DIRECT MAPPINGS ───────────────────────────────────────────────────
app.post('/api/mappings', requireAuth, async (req, res) => {
  const { mappings } = req.body; // [{ txnId, itemId, subId }]
  if (!Array.isArray(mappings) || !mappings.length) return res.json({ ok: true });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of mappings) {
      await client.query(
        `INSERT INTO direct_mappings (txn_id, item_id, sub_id) VALUES ($1,$2,$3)
         ON CONFLICT (txn_id) DO UPDATE SET item_id=$2, sub_id=$3`,
        [m.txnId, m.itemId, m.subId]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.delete('/api/mappings', requireAuth, async (req, res) => {
  const { txnIds } = req.body;
  if (Array.isArray(txnIds) && txnIds.length) {
    await pool.query('DELETE FROM direct_mappings WHERE txn_id = ANY($1)', [txnIds]);
  } else {
    await pool.query('DELETE FROM direct_mappings');
  }
  res.json({ ok: true });
});

// ── AUDIT LOG ─────────────────────────────────────────────────────────
app.get('/api/audit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 100, 500);
    const offset = Math.max(parseInt(req.query.offset) || 0,   0);
    const { rows } = await pool.query(
      `SELECT al.id, al.action, al.detail, al.ip, al.created_at,
              u.name AS user_name, u.email AS user_email
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       ORDER BY al.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM audit_log');
    res.json({ rows, total: parseInt(countRows[0].count) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PLANNING: VERSIONS ───────────────────────────────────────────────

// List versions, optionally filtered by year
app.get('/api/plan/versions', requireAuth, async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year) : null;
    const { rows } = await pool.query(
      `SELECT pv.*,
              cb.name AS created_by_name,
              ub.name AS updated_by_name,
              lb.name AS locked_by_name,
              (SELECT COUNT(*) FROM plan_entries pe WHERE pe.version_id = pv.id) AS entry_count,
              (SELECT COUNT(*) FROM plan_assumptions pa WHERE pa.version_id = pv.id) AS assumption_count
       FROM plan_versions pv
       LEFT JOIN users cb ON cb.id = pv.created_by
       LEFT JOIN users ub ON ub.id = pv.updated_by
       LEFT JOIN users lb ON lb.id = pv.locked_by
       ${year ? 'WHERE pv.year = $1' : ''}
       ORDER BY pv.year DESC, pv.created_at DESC`,
      year ? [year] : []
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a new version
app.post('/api/plan/versions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, year, type = 'budget', notes } = req.body;
    if (!name || !year) return res.status(400).json({ error: 'name and year are required' });
    if (!['budget', 'forecast', 'scenario'].includes(type))
      return res.status(400).json({ error: 'type must be budget, forecast, or scenario' });
    const { rows } = await pool.query(
      `INSERT INTO plan_versions (name, year, type, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING *`,
      [name.trim(), parseInt(year), type, notes || null, req.user.id]
    );
    logAudit(req.user.id, 'plan.version.create', `id=${rows[0].id} name="${rows[0].name}" year=${rows[0].year}`, req);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get a single version (with entries and assumptions)
app.get('/api/plan/versions/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: vRows } = await pool.query(
      `SELECT pv.*, cb.name AS created_by_name, ub.name AS updated_by_name, lb.name AS locked_by_name
       FROM plan_versions pv
       LEFT JOIN users cb ON cb.id = pv.created_by
       LEFT JOIN users ub ON ub.id = pv.updated_by
       LEFT JOIN users lb ON lb.id = pv.locked_by
       WHERE pv.id = $1`, [id]
    );
    if (!vRows.length) return res.status(404).json({ error: 'Version not found' });
    const { rows: entries }     = await pool.query('SELECT * FROM plan_entries WHERE version_id=$1 ORDER BY item_id, month', [id]);
    const { rows: assumptions } = await pool.query('SELECT * FROM plan_assumptions WHERE version_id=$1 ORDER BY sort_order, id', [id]);
    res.json({ ...vRows[0], entries, assumptions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update version metadata (name, type, notes)
app.patch('/api/plan/versions/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, type, notes } = req.body;
    // Refuse writes to locked versions
    const { rows: check } = await pool.query('SELECT locked_at FROM plan_versions WHERE id=$1', [id]);
    if (!check.length) return res.status(404).json({ error: 'Version not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const { rows } = await pool.query(
      `UPDATE plan_versions
       SET name=$1, type=COALESCE($2,type), notes=$3, updated_by=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [name, type || null, notes ?? null, req.user.id, id]
    );
    logAudit(req.user.id, 'plan.version.update', `id=${id}`, req);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lock / unlock a version
app.post('/api/plan/versions/:id/lock', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { locked } = req.body; // true = lock, false = unlock
    const { rows } = await pool.query(
      `UPDATE plan_versions
       SET locked_at = $1, locked_by = $2, updated_by = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [locked ? new Date() : null, locked ? req.user.id : null, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Version not found' });
    logAudit(req.user.id, locked ? 'plan.version.lock' : 'plan.version.unlock', `id=${id}`, req);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a version (cascades to entries + assumptions)
app.delete('/api/plan/versions/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: check } = await pool.query('SELECT locked_at, name FROM plan_versions WHERE id=$1', [id]);
    if (!check.length) return res.status(404).json({ error: 'Version not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Cannot delete a locked version' });
    await pool.query('DELETE FROM plan_versions WHERE id=$1', [id]);
    logAudit(req.user.id, 'plan.version.delete', `id=${id} name="${check[0].name}"`, req);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PLANNING: ENTRIES ─────────────────────────────────────────────────

// Get all entries for a version (optionally filtered by item_id)
app.get('/api/plan/versions/:id/entries', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows } = await pool.query(
      `SELECT pe.*, u.name AS updated_by_name
       FROM plan_entries pe
       LEFT JOIN users u ON u.id = pe.updated_by
       WHERE pe.version_id = $1
       ${req.query.item_id ? 'AND pe.item_id = $2' : ''}
       ORDER BY pe.item_id, pe.month`,
      req.query.item_id ? [id, req.query.item_id] : [id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bulk upsert monthly entries for a version.
// Body: { entries: [{ item_id, month, year, amount, note }] }
app.put('/api/plan/versions/:id/entries', requireAuth, requireAdmin, async (req, res) => {
  const versionId = parseInt(req.params.id);
  const { entries } = req.body;
  if (!Array.isArray(entries) || entries.length === 0)
    return res.status(400).json({ error: 'entries array required' });

  // Validate
  for (const e of entries) {
    if (!e.item_id) return res.status(400).json({ error: 'each entry needs item_id' });
    if (!e.month || e.month < 1 || e.month > 12) return res.status(400).json({ error: `invalid month: ${e.month}` });
    if (!e.year) return res.status(400).json({ error: 'each entry needs year' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Refuse writes to locked versions
    const { rows: check } = await client.query('SELECT locked_at FROM plan_versions WHERE id=$1', [versionId]);
    if (!check.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Version not found' }); }
    if (check[0].locked_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Version is locked' }); }

    for (const e of entries) {
      if (e.line_item_id) {
        // Line-item-scoped entry — use the partial unique index
        await client.query(
          `INSERT INTO plan_entries
             (version_id, line_item_id, item_id, month, year, amount, note, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (version_id, line_item_id, month) WHERE line_item_id IS NOT NULL
           DO UPDATE SET amount=$6, note=$7, updated_by=$8, updated_at=NOW()`,
          [versionId, e.line_item_id, e.item_id, e.month, e.year, e.amount ?? 0, e.note ?? null, req.user.id]
        );
      } else {
        // Legacy entry without line_item_id — plain insert
        await client.query(
          `INSERT INTO plan_entries (version_id, item_id, month, year, amount, note, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
           ON CONFLICT DO NOTHING`,
          [versionId, e.item_id, e.month, e.year, e.amount ?? 0, e.note ?? null, req.user.id]
        );
      }
    }
    await client.query(
      'UPDATE plan_versions SET updated_by=$1, updated_at=NOW() WHERE id=$2',
      [req.user.id, versionId]
    );
    await client.query('COMMIT');
    logAudit(req.user.id, 'plan.entries.upsert', `version_id=${versionId} count=${entries.length}`, req);
    res.json({ ok: true, count: entries.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PLANNING: LINE ITEMS ──────────────────────────────────────────────

const VALID_CATEGORIES = new Set(['revenue','personnel','opex','other']);

// List line items for a version, optionally filtered by category
app.get('/api/plan/versions/:id/line-items', requireAuth, async (req, res) => {
  try {
    const versionId = parseInt(req.params.id);
    const { category, active_only } = req.query;
    let where = 'WHERE pli.version_id = $1';
    const params = [versionId];
    if (category) { params.push(category); where += ` AND pli.category = $${params.length}`; }
    if (active_only !== 'false') where += ' AND pli.is_active = TRUE';
    const { rows } = await pool.query(
      `SELECT pli.*, cb.name AS created_by_name, ub.name AS updated_by_name
       FROM plan_line_items pli
       LEFT JOIN users cb ON cb.id = pli.created_by
       LEFT JOIN users ub ON ub.id = pli.updated_by
       ${where}
       ORDER BY pli.category, pli.sort_order, pli.id`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a line item
app.post('/api/plan/versions/:id/line-items', requireAuth, requireAdmin, async (req, res) => {
  try {
    const versionId = parseInt(req.params.id);
    const { label, item_id, category = 'other', entity, fund_ref,
            department, counterparty, notes, sort_order = 0 } = req.body;

    if (!label || !item_id) return res.status(400).json({ error: 'label and item_id are required' });
    if (!VALID_CATEGORIES.has(category))
      return res.status(400).json({ error: `category must be one of: ${[...VALID_CATEGORIES].join(', ')}` });

    const { rows: vCheck } = await pool.query('SELECT locked_at FROM plan_versions WHERE id=$1', [versionId]);
    if (!vCheck.length) return res.status(404).json({ error: 'Version not found' });
    if (vCheck[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const { rows } = await pool.query(
      `INSERT INTO plan_line_items
         (version_id, label, item_id, category, entity, fund_ref, department,
          counterparty, notes, sort_order, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       RETURNING *`,
      [versionId, label.trim(), item_id, category,
       entity || null, fund_ref || null, department || null,
       counterparty || null, notes || null, sort_order, req.user.id]
    );
    logAudit(req.user.id, 'plan.line_item.create', `id=${rows[0].id} label="${rows[0].label}"`, req);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update a line item (metadata only — amounts are in plan_entries)
app.patch('/api/plan/versions/:vid/line-items/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { label, item_id, category, entity, fund_ref,
            department, counterparty, notes, sort_order, is_active } = req.body;

    if (category !== undefined && !VALID_CATEGORIES.has(category))
      return res.status(400).json({ error: `category must be one of: ${[...VALID_CATEGORIES].join(', ')}` });

    const { rows: check } = await pool.query(
      `SELECT pli.id, pv.locked_at
       FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id
       WHERE pli.id = $1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Line item not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const { rows } = await pool.query(
      `UPDATE plan_line_items SET
         label        = COALESCE($1,  label),
         item_id      = COALESCE($2,  item_id),
         category     = COALESCE($3,  category),
         entity       = COALESCE($4,  entity),
         fund_ref     = COALESCE($5,  fund_ref),
         department   = COALESCE($6,  department),
         counterparty = COALESCE($7,  counterparty),
         notes        = COALESCE($8,  notes),
         sort_order   = COALESCE($9,  sort_order),
         is_active    = COALESCE($10, is_active),
         updated_by   = $11,
         updated_at   = NOW()
       WHERE id = $12
       RETURNING *`,
      [label ?? null, item_id ?? null, category ?? null,
       entity ?? null, fund_ref ?? null, department ?? null,
       counterparty ?? null, notes ?? null,
       sort_order ?? null, is_active ?? null, req.user.id, id]
    );
    logAudit(req.user.id, 'plan.line_item.update', `id=${id}`, req);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bulk upsert monthly entries for a specific line item.
// Body: { entries: [{ month, amount, note }] } — year and item_id are inferred from the line item.
app.put('/api/plan/versions/:vid/line-items/:id/entries', requireAuth, requireAdmin, async (req, res) => {
  const lineItemId = parseInt(req.params.id);
  const { entries } = req.body;
  if (!Array.isArray(entries) || entries.length === 0)
    return res.status(400).json({ error: 'entries array required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: liRows } = await client.query(
      `SELECT pli.item_id, pv.year, pv.locked_at
       FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id
       WHERE pli.id = $1`, [lineItemId]
    );
    if (!liRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Line item not found' }); }
    if (liRows[0].locked_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Version is locked' }); }

    const { item_id, year } = liRows[0];
    const versionId = parseInt(req.params.vid);

    for (const e of entries) {
      if (!e.month || e.month < 1 || e.month > 12)
        { await client.query('ROLLBACK'); return res.status(400).json({ error: `invalid month: ${e.month}` }); }
      await client.query(
        `INSERT INTO plan_entries
           (version_id, line_item_id, item_id, month, year, amount, note, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (version_id, line_item_id, month)
         WHERE line_item_id IS NOT NULL
         DO UPDATE SET amount=$6, note=$7, updated_by=$8, updated_at=NOW()`,
        [versionId, lineItemId, item_id, e.month, year, e.amount ?? 0, e.note ?? null, req.user.id]
      );
    }
    await client.query('COMMIT');
    logAudit(req.user.id, 'plan.line_item.entries.upsert', `line_item_id=${lineItemId} count=${entries.length}`, req);
    res.json({ ok: true, count: entries.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Get entries for a single line item
app.get('/api/plan/versions/:vid/line-items/:id/entries', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM plan_entries WHERE line_item_id=$1 ORDER BY month',
      [parseInt(req.params.id)]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Soft-delete a line item (sets is_active=false, cascades nothing)
app.delete('/api/plan/versions/:vid/line-items/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: check } = await pool.query(
      `SELECT pli.id, pv.locked_at FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id WHERE pli.id=$1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Line item not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });
    await pool.query(
      'UPDATE plan_line_items SET is_active=FALSE, updated_by=$1, updated_at=NOW() WHERE id=$2',
      [req.user.id, id]
    );
    logAudit(req.user.id, 'plan.line_item.delete', `id=${id}`, req);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PLANNING: ASSUMPTIONS ─────────────────────────────────────────────

// Get all assumptions for a version
app.get('/api/plan/versions/:id/assumptions', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pa.*, u.name AS updated_by_name
       FROM plan_assumptions pa
       LEFT JOIN users u ON u.id = pa.updated_by
       WHERE pa.version_id = $1
       ORDER BY pa.sort_order, pa.id`,
      [parseInt(req.params.id)]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Replace all assumptions for a version (full replace, not merge)
// Body: { assumptions: [{ label, value, note, sort_order }] }
app.put('/api/plan/versions/:id/assumptions', requireAuth, requireAdmin, async (req, res) => {
  const versionId = parseInt(req.params.id);
  const { assumptions } = req.body;
  if (!Array.isArray(assumptions)) return res.status(400).json({ error: 'assumptions array required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: check } = await client.query('SELECT locked_at FROM plan_versions WHERE id=$1', [versionId]);
    if (!check.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Version not found' }); }
    if (check[0].locked_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Version is locked' }); }

    await client.query('DELETE FROM plan_assumptions WHERE version_id=$1', [versionId]);
    for (let i = 0; i < assumptions.length; i++) {
      const a = assumptions[i];
      if (!a.label) continue;
      await client.query(
        `INSERT INTO plan_assumptions (version_id, label, value, note, sort_order, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [versionId, a.label, a.value ?? '', a.note ?? null, a.sort_order ?? i, req.user.id]
      );
    }
    await client.query('COMMIT');
    logAudit(req.user.id, 'plan.assumptions.update', `version_id=${versionId}`, req);
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PLANNING: REVENUE DRIVERS ─────────────────────────────────────────

const VALID_DRIVER_TYPES = new Set(['annual_fee', 'monthly_flat', 'one_off', 'quarterly_flat', 'management_fee']);

// List drivers for a line item
app.get('/api/plan/line-items/:liId/drivers', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT prd.*, u.name AS updated_by_name
       FROM plan_revenue_drivers prd
       LEFT JOIN users u ON u.id = prd.updated_by
       WHERE prd.line_item_id = $1
       ORDER BY prd.id`,
      [parseInt(req.params.liId)]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a driver
app.post('/api/plan/line-items/:liId/drivers', requireAuth, requireAdmin, async (req, res) => {
  try {
    const lineItemId = parseInt(req.params.liId);
    const { driver_type = 'annual_fee', start_date, end_date,
            spread_method = 'even', notes, vendor, recurrence,
            commitment, fee_pct } = req.body;
    let { amount } = req.body;

    if (!VALID_DRIVER_TYPES.has(driver_type))
      return res.status(400).json({ error: `driver_type must be one of: ${[...VALID_DRIVER_TYPES].join(', ')}` });
    if (!['even'].includes(spread_method))
      return res.status(400).json({ error: 'spread_method must be even' });

    // management_fee: derive amount from commitment × fee_pct
    if (driver_type === 'management_fee') {
      if (commitment == null || fee_pct == null)
        return res.status(400).json({ error: 'management_fee requires commitment and fee_pct' });
      amount = Math.round(Number(commitment) * Number(fee_pct) / 100 * 100) / 100;
    } else if (amount === undefined || amount === null) {
      return res.status(400).json({ error: 'amount is required' });
    }

    // Verify the line item exists and its version isn't locked
    const { rows: liCheck } = await pool.query(
      `SELECT pli.id, pv.locked_at FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id
       WHERE pli.id = $1`, [lineItemId]
    );
    if (!liCheck.length) return res.status(404).json({ error: 'Line item not found' });
    if (liCheck[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const { rows } = await pool.query(
      `INSERT INTO plan_revenue_drivers
         (line_item_id, driver_type, amount, start_date, end_date, spread_method, notes, vendor, recurrence, commitment, fee_pct, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
       RETURNING *`,
      [lineItemId, driver_type, amount, start_date || null, end_date || null,
       spread_method, notes || null, vendor || null, recurrence || null,
       commitment != null ? Number(commitment) : null,
       fee_pct    != null ? Number(fee_pct)    : null,
       req.user.id]
    );
    logAudit(req.user.id, 'plan.driver.create', `id=${rows[0].id} line_item_id=${lineItemId} type=${driver_type}`, req);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update a driver
app.patch('/api/plan/line-items/:liId/drivers/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { driver_type, start_date, end_date, spread_method, notes, vendor, recurrence,
            commitment, fee_pct } = req.body;
    let { amount } = req.body;

    if (driver_type !== undefined && !VALID_DRIVER_TYPES.has(driver_type))
      return res.status(400).json({ error: `driver_type must be one of: ${[...VALID_DRIVER_TYPES].join(', ')}` });

    const { rows: check } = await pool.query(
      `SELECT prd.id, prd.driver_type, prd.commitment, prd.fee_pct, pv.locked_at
       FROM plan_revenue_drivers prd
       JOIN plan_line_items pli ON pli.id = prd.line_item_id
       JOIN plan_versions pv   ON pv.id  = pli.version_id
       WHERE prd.id = $1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Driver not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    // Re-derive amount if this is (or is becoming) a management_fee driver
    const effectiveType = driver_type ?? check[0].driver_type;
    if (effectiveType === 'management_fee') {
      const effCommitment = commitment != null ? Number(commitment) : Number(check[0].commitment);
      const effFeePct     = fee_pct    != null ? Number(fee_pct)    : Number(check[0].fee_pct);
      amount = Math.round(effCommitment * effFeePct / 100 * 100) / 100;
    }

    const { rows } = await pool.query(
      `UPDATE plan_revenue_drivers SET
         driver_type   = COALESCE($1, driver_type),
         amount        = COALESCE($2, amount),
         start_date    = COALESCE($3, start_date),
         end_date      = COALESCE($4, end_date),
         spread_method = COALESCE($5, spread_method),
         notes         = COALESCE($6, notes),
         vendor        = COALESCE($7, vendor),
         recurrence    = COALESCE($8, recurrence),
         commitment    = COALESCE($9, commitment),
         fee_pct       = COALESCE($10, fee_pct),
         updated_by    = $11,
         updated_at    = NOW()
       WHERE id = $12 RETURNING *`,
      [driver_type ?? null, amount ?? null, start_date ?? null,
       end_date ?? null, spread_method ?? null, notes ?? null,
       vendor ?? null, recurrence ?? null,
       commitment != null ? Number(commitment) : null,
       fee_pct    != null ? Number(fee_pct)    : null,
       req.user.id, id]
    );
    logAudit(req.user.id, 'plan.driver.update', `id=${id}`, req);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a driver
app.delete('/api/plan/line-items/:liId/drivers/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: check } = await pool.query(
      `SELECT prd.id, pv.locked_at FROM plan_revenue_drivers prd
       JOIN plan_line_items pli ON pli.id = prd.line_item_id
       JOIN plan_versions pv   ON pv.id  = pli.version_id
       WHERE prd.id = $1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Driver not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });
    await pool.query('DELETE FROM plan_revenue_drivers WHERE id=$1', [id]);
    logAudit(req.user.id, 'plan.driver.delete', `id=${id}`, req);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate monthly entries from all drivers on a line item.
// Skips months where is_manual_override=TRUE.
// Returns a preview when ?dry_run=true — no DB writes.
app.post('/api/plan/line-items/:liId/generate', requireAuth, requireAdmin, async (req, res) => {
  const lineItemId = parseInt(req.params.liId);
  const dryRun = req.query.dry_run === 'true';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: liRows } = await client.query(
      `SELECT pli.item_id, pv.year, pv.locked_at, pv.id AS version_id
       FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id
       WHERE pli.id = $1`, [lineItemId]
    );
    if (!liRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Line item not found' }); }
    if (liRows[0].locked_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Version is locked' }); }

    const { item_id, year, version_id } = liRows[0];

    // Load all drivers for this line item
    const { rows: drivers } = await client.query(
      'SELECT * FROM plan_revenue_drivers WHERE line_item_id=$1',
      [lineItemId]
    );

    // Load manual override flags for this line item
    const { rows: existingEntries } = await client.query(
      'SELECT month, is_manual_override FROM plan_entries WHERE version_id=$1 AND line_item_id=$2',
      [version_id, lineItemId]
    );
    const manualMonths = new Set(
      existingEntries.filter(e => e.is_manual_override).map(e => e.month)
    );

    // Spread all drivers, then filter out manual-override months
    const generated = spreadDrivers(drivers, year)
      .filter(e => !manualMonths.has(e.month));

    if (dryRun) {
      await client.query('ROLLBACK');
      return res.json({
        dry_run: true,
        year,
        generated,
        skipped_manual_months: [...manualMonths].sort(),
      });
    }

    // Upsert generated entries (only non-override months)
    for (const e of generated) {
      await client.query(
        `INSERT INTO plan_entries
           (version_id, line_item_id, item_id, month, year, amount, is_manual_override, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7,NOW())
         ON CONFLICT (version_id, line_item_id, month)
         WHERE line_item_id IS NOT NULL
         DO UPDATE SET amount=$6, is_manual_override=FALSE, updated_by=$7, updated_at=NOW()`,
        [version_id, lineItemId, item_id, e.month, year, e.amount, req.user.id]
      );
    }

    await client.query('COMMIT');
    logAudit(req.user.id, 'plan.generate', `line_item_id=${lineItemId} generated=${generated.length} skipped_manual=${manualMonths.size}`, req);
    res.json({
      ok: true,
      generated: generated.length,
      skipped_manual_months: [...manualMonths].sort(),
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PLANNING: PERSONNEL DRIVERS ──────────────────────────────────────

// List personnel drivers for a line item
app.get('/api/plan/line-items/:liId/personnel', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ppd.*, u.name AS updated_by_name
       FROM plan_personnel_drivers ppd
       LEFT JOIN users u ON u.id = ppd.updated_by
       WHERE ppd.line_item_id = $1
       ORDER BY ppd.is_filled DESC, ppd.start_date NULLS FIRST, ppd.id`,
      [parseInt(req.params.liId)]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a personnel driver
app.post('/api/plan/line-items/:liId/personnel', requireAuth, requireAdmin, async (req, res) => {
  try {
    const lineItemId = parseInt(req.params.liId);
    const {
      employee_name, role_title, department, country, is_filled = true,
      start_date, end_date,
      annual_gross_salary, payroll_burden_rate = 0,
      salary_increase_date, annual_gross_salary_post_increase,
      annual_bonus = 0, bonus_month = 12,
      notes,
    } = req.body;

    if (!employee_name) return res.status(400).json({ error: 'employee_name is required' });
    if (annual_gross_salary === undefined || annual_gross_salary === null)
      return res.status(400).json({ error: 'annual_gross_salary is required' });
    if (bonus_month < 1 || bonus_month > 12)
      return res.status(400).json({ error: 'bonus_month must be 1–12' });
    if (payroll_burden_rate < 0)
      return res.status(400).json({ error: 'payroll_burden_rate must be >= 0' });

    const { rows: liCheck } = await pool.query(
      `SELECT pli.id, pv.locked_at FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id
       WHERE pli.id = $1 AND pli.category = 'personnel'`,
      [lineItemId]
    );
    if (!liCheck.length)
      return res.status(404).json({ error: 'Personnel line item not found (must have category=personnel)' });
    if (liCheck[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const { rows } = await pool.query(
      `INSERT INTO plan_personnel_drivers
         (line_item_id, employee_name, role_title, department, country, is_filled,
          start_date, end_date, annual_gross_salary, payroll_burden_rate,
          salary_increase_date, annual_gross_salary_post_increase,
          annual_bonus, bonus_month, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
       RETURNING *`,
      [
        lineItemId, employee_name, role_title || null, department || null, country || null, is_filled,
        start_date || null, end_date || null,
        annual_gross_salary, payroll_burden_rate,
        salary_increase_date || null, annual_gross_salary_post_increase || null,
        annual_bonus, bonus_month, notes || null, req.user.id,
      ]
    );
    logAudit(req.user.id, 'plan.personnel.create',
      `id=${rows[0].id} name="${employee_name}" line_item_id=${lineItemId}`, req);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update a personnel driver
app.patch('/api/plan/line-items/:liId/personnel/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: check } = await pool.query(
      `SELECT ppd.id, pv.locked_at FROM plan_personnel_drivers ppd
       JOIN plan_line_items pli ON pli.id = ppd.line_item_id
       JOIN plan_versions   pv  ON pv.id  = pli.version_id
       WHERE ppd.id = $1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Personnel driver not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const f = req.body;
    const { rows } = await pool.query(
      `UPDATE plan_personnel_drivers SET
         employee_name         = COALESCE($1,  employee_name),
         role_title            = COALESCE($2,  role_title),
         department            = COALESCE($3,  department),
         country               = COALESCE($4,  country),
         is_filled             = COALESCE($5,  is_filled),
         start_date            = COALESCE($6,  start_date),
         end_date              = COALESCE($7,  end_date),
         annual_gross_salary   = COALESCE($8,  annual_gross_salary),
         payroll_burden_rate   = COALESCE($9,  payroll_burden_rate),
         salary_increase_date  = COALESCE($10, salary_increase_date),
         annual_gross_salary_post_increase = COALESCE($11, annual_gross_salary_post_increase),
         annual_bonus          = COALESCE($12, annual_bonus),
         bonus_month           = COALESCE($13, bonus_month),
         notes                 = COALESCE($14, notes),
         updated_by            = $15,
         updated_at            = NOW()
       WHERE id = $16 RETURNING *`,
      [
        f.employee_name ?? null, f.role_title ?? null, f.department ?? null, f.country ?? null,
        f.is_filled ?? null, f.start_date ?? null, f.end_date ?? null,
        f.annual_gross_salary ?? null, f.payroll_burden_rate ?? null,
        f.salary_increase_date ?? null, f.annual_gross_salary_post_increase ?? null,
        f.annual_bonus ?? null, f.bonus_month ?? null,
        f.notes ?? null, req.user.id, id,
      ]
    );
    logAudit(req.user.id, 'plan.personnel.update', `id=${id}`, req);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a personnel driver
app.delete('/api/plan/line-items/:liId/personnel/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: check } = await pool.query(
      `SELECT ppd.id, pv.locked_at FROM plan_personnel_drivers ppd
       JOIN plan_line_items pli ON pli.id = ppd.line_item_id
       JOIN plan_versions   pv  ON pv.id  = pli.version_id
       WHERE ppd.id = $1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Personnel driver not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });
    await pool.query('DELETE FROM plan_personnel_drivers WHERE id=$1', [id]);
    logAudit(req.user.id, 'plan.personnel.delete', `id=${id}`, req);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate monthly entries from all personnel drivers on a line item.
// Skips months with is_manual_override=TRUE.
// ?dry_run=true returns a preview without writing.
app.post('/api/plan/line-items/:liId/generate-personnel', requireAuth, requireAdmin, async (req, res) => {
  const lineItemId = parseInt(req.params.liId);
  const dryRun = req.query.dry_run === 'true';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: liRows } = await client.query(
      `SELECT pli.item_id, pv.year, pv.locked_at, pv.id AS version_id
       FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id
       WHERE pli.id = $1 AND pli.category = 'personnel'`, [lineItemId]
    );
    if (!liRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Personnel line item not found' });
    }
    if (liRows[0].locked_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Version is locked' });
    }

    const { item_id, year, version_id } = liRows[0];

    const { rows: drivers } = await client.query(
      'SELECT * FROM plan_personnel_drivers WHERE line_item_id=$1',
      [lineItemId]
    );
    const { rows: existingEntries } = await client.query(
      'SELECT month, is_manual_override FROM plan_entries WHERE version_id=$1 AND line_item_id=$2',
      [version_id, lineItemId]
    );
    const manualMonths = new Set(
      existingEntries.filter(e => e.is_manual_override).map(e => e.month)
    );

    const generated = spreadPersonnelDrivers(drivers, year)
      .filter(e => !manualMonths.has(e.month));

    if (dryRun) {
      await client.query('ROLLBACK');
      return res.json({
        dry_run: true, year, generated,
        skipped_manual_months: [...manualMonths].sort(),
      });
    }

    for (const e of generated) {
      await client.query(
        `INSERT INTO plan_entries
           (version_id, line_item_id, item_id, month, year, amount, is_manual_override, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7,NOW())
         ON CONFLICT (version_id, line_item_id, month)
         WHERE line_item_id IS NOT NULL
         DO UPDATE SET amount=$6, is_manual_override=FALSE, updated_by=$7, updated_at=NOW()`,
        [version_id, lineItemId, item_id, e.month, year, e.amount, req.user.id]
      );
    }

    await client.query('COMMIT');
    logAudit(req.user.id, 'plan.personnel.generate',
      `line_item_id=${lineItemId} generated=${generated.length} skipped_manual=${manualMonths.size}`, req);
    res.json({
      ok: true,
      generated: generated.length,
      skipped_manual_months: [...manualMonths].sort(),
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PLANNING: OPEX GENERATE ───────────────────────────────────────────

// Generate monthly entries for an opex line item from its revenue drivers.
// Validates category='opex'. Skips is_manual_override months.
app.post('/api/plan/line-items/:liId/generate-opex', requireAuth, requireAdmin, async (req, res) => {
  const lineItemId = parseInt(req.params.liId);
  const dryRun = req.query.dry_run === 'true';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: liRows } = await client.query(
      `SELECT pli.item_id, pv.year, pv.locked_at, pv.id AS version_id
       FROM plan_line_items pli
       JOIN plan_versions pv ON pv.id = pli.version_id
       WHERE pli.id = $1 AND pli.category = 'opex'`, [lineItemId]
    );
    if (!liRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Opex line item not found' });
    }
    if (liRows[0].locked_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Version is locked' });
    }

    const { item_id, year, version_id } = liRows[0];

    const { rows: drivers } = await client.query(
      'SELECT * FROM plan_revenue_drivers WHERE line_item_id=$1',
      [lineItemId]
    );
    const { rows: existingEntries } = await client.query(
      'SELECT month, is_manual_override FROM plan_entries WHERE version_id=$1 AND line_item_id=$2',
      [version_id, lineItemId]
    );
    const manualMonths = new Set(
      existingEntries.filter(e => e.is_manual_override).map(e => e.month)
    );

    const generated = spreadDrivers(drivers, year)
      .filter(e => !manualMonths.has(e.month));

    if (dryRun) {
      await client.query('ROLLBACK');
      return res.json({
        dry_run: true, year, generated,
        skipped_manual_months: [...manualMonths].sort(),
      });
    }

    for (const e of generated) {
      await client.query(
        `INSERT INTO plan_entries
           (version_id, line_item_id, item_id, month, year, amount, is_manual_override, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7,NOW())
         ON CONFLICT (version_id, line_item_id, month)
         WHERE line_item_id IS NOT NULL
         DO UPDATE SET amount=$6, is_manual_override=FALSE, updated_by=$7, updated_at=NOW()`,
        [version_id, lineItemId, item_id, e.month, year, e.amount, req.user.id]
      );
    }

    await client.query('COMMIT');
    logAudit(req.user.id, 'plan.opex.generate',
      `line_item_id=${lineItemId} generated=${generated.length} skipped_manual=${manualMonths.size}`, req);
    res.json({
      ok: true,
      generated: generated.length,
      skipped_manual_months: [...manualMonths].sort(),
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PLANNING: COST ALLOCATION ─────────────────────────────────────────

const VALID_ALLOC_METHODS = new Set(['fixed_pct', 'equal_split', 'manual']);

// List allocation rules for a version
app.get('/api/plan/versions/:vId/allocation-rules', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT par.*, pli.label AS source_label
       FROM plan_allocation_rules par
       JOIN plan_line_items pli ON pli.id = par.source_line_item_id
       WHERE par.version_id = $1
       ORDER BY par.id`,
      [parseInt(req.params.vId)]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get one rule with its targets
app.get('/api/plan/allocation-rules/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: rule } = await pool.query(
      `SELECT par.*, pli.label AS source_label
       FROM plan_allocation_rules par
       JOIN plan_line_items pli ON pli.id = par.source_line_item_id
       WHERE par.id = $1`, [id]
    );
    if (!rule.length) return res.status(404).json({ error: 'Rule not found' });
    const { rows: targets } = await pool.query(
      'SELECT * FROM plan_allocation_targets WHERE rule_id=$1 ORDER BY sort_order, id', [id]
    );
    res.json({ ...rule[0], targets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a rule
app.post('/api/plan/versions/:vId/allocation-rules', requireAuth, requireAdmin, async (req, res) => {
  try {
    const versionId = parseInt(req.params.vId);
    const { label, source_line_item_id, method = 'fixed_pct', notes, targets = [] } = req.body;

    if (!label) return res.status(400).json({ error: 'label is required' });
    if (!source_line_item_id) return res.status(400).json({ error: 'source_line_item_id is required' });
    if (!VALID_ALLOC_METHODS.has(method))
      return res.status(400).json({ error: `method must be one of: ${[...VALID_ALLOC_METHODS].join(', ')}` });

    if (method === 'fixed_pct' && targets.length) {
      const totalPct = targets.reduce((s, t) => s + (Number(t.pct_share) || 0), 0);
      if (totalPct > 100.0001)
        return res.status(400).json({ error: `pct_share values sum to ${totalPct.toFixed(2)}%, must be ≤ 100` });
    }

    const { rows: vCheck } = await pool.query(
      'SELECT locked_at FROM plan_versions WHERE id=$1', [versionId]
    );
    if (!vCheck.length) return res.status(404).json({ error: 'Version not found' });
    if (vCheck[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: ruleRows } = await client.query(
        `INSERT INTO plan_allocation_rules
           (version_id, label, source_line_item_id, method, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
        [versionId, label, source_line_item_id, method, notes || null, req.user.id]
      );
      const rule = ruleRows[0];

      const insertedTargets = [];
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const { rows: tr } = await client.query(
          `INSERT INTO plan_allocation_targets
             (rule_id, label, entity, fund_ref, pct_share, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [rule.id, t.label, t.entity || null, t.fund_ref || null,
           t.pct_share ?? null, t.sort_order ?? i]
        );
        insertedTargets.push(tr[0]);
      }

      await client.query('COMMIT');
      logAudit(req.user.id, 'plan.allocation.create',
        `rule_id=${rule.id} method=${method} targets=${insertedTargets.length}`, req);
      res.status(201).json({ ...rule, targets: insertedTargets });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update rule metadata (not targets — manage targets separately)
app.patch('/api/plan/allocation-rules/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { label, method, notes, is_active } = req.body;

    if (method !== undefined && !VALID_ALLOC_METHODS.has(method))
      return res.status(400).json({ error: `method must be one of: ${[...VALID_ALLOC_METHODS].join(', ')}` });

    const { rows: check } = await pool.query(
      `SELECT par.id, pv.locked_at FROM plan_allocation_rules par
       JOIN plan_versions pv ON pv.id = par.version_id WHERE par.id=$1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Rule not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    const { rows } = await pool.query(
      `UPDATE plan_allocation_rules SET
         label      = COALESCE($1, label),
         method     = COALESCE($2, method),
         notes      = COALESCE($3, notes),
         is_active  = COALESCE($4, is_active),
         updated_by = $5, updated_at = NOW()
       WHERE id=$6 RETURNING *`,
      [label ?? null, method ?? null, notes ?? null, is_active ?? null, req.user.id, id]
    );
    logAudit(req.user.id, 'plan.allocation.update', `rule_id=${id}`, req);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a rule
app.delete('/api/plan/allocation-rules/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rows: check } = await pool.query(
      `SELECT par.id, pv.locked_at FROM plan_allocation_rules par
       JOIN plan_versions pv ON pv.id = par.version_id WHERE par.id=$1`, [id]
    );
    if (!check.length) return res.status(404).json({ error: 'Rule not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });
    await pool.query('DELETE FROM plan_allocation_rules WHERE id=$1', [id]);
    logAudit(req.user.id, 'plan.allocation.delete', `rule_id=${id}`, req);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Targets ───────────────────────────────────────────────────────────

// Upsert all targets for a rule (replaces the current target list)
app.put('/api/plan/allocation-rules/:id/targets', requireAuth, requireAdmin, async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id);
    const { targets = [] } = req.body;

    const { rows: check } = await pool.query(
      `SELECT par.id, par.method, pv.locked_at FROM plan_allocation_rules par
       JOIN plan_versions pv ON pv.id = par.version_id WHERE par.id=$1`, [ruleId]
    );
    if (!check.length) return res.status(404).json({ error: 'Rule not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });

    if (check[0].method === 'fixed_pct' && targets.length) {
      const totalPct = targets.reduce((s, t) => s + (Number(t.pct_share) || 0), 0);
      if (totalPct > 100.0001)
        return res.status(400).json({ error: `pct_share values sum to ${totalPct.toFixed(2)}%, must be ≤ 100` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM plan_allocation_targets WHERE rule_id=$1', [ruleId]);
      const inserted = [];
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const { rows } = await client.query(
          `INSERT INTO plan_allocation_targets
             (rule_id, label, entity, fund_ref, pct_share, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [ruleId, t.label, t.entity || null, t.fund_ref || null,
           t.pct_share ?? null, t.sort_order ?? i]
        );
        inserted.push(rows[0]);
      }
      await client.query('COMMIT');
      logAudit(req.user.id, 'plan.allocation.targets.update',
        `rule_id=${ruleId} count=${inserted.length}`, req);
      res.json(inserted);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Generate ──────────────────────────────────────────────────────────

// Generate allocation results for a rule from current source line item entries.
// For 'manual' method, existing results are preserved unless overwritten.
// ?dry_run=true returns the computed values without writing to DB.
app.post('/api/plan/allocation-rules/:id/generate', requireAuth, requireAdmin, async (req, res) => {
  const ruleId = parseInt(req.params.id);
  const dryRun = req.query.dry_run === 'true';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: ruleRows } = await client.query(
      `SELECT par.*, pv.year, pv.locked_at
       FROM plan_allocation_rules par
       JOIN plan_versions pv ON pv.id = par.version_id
       WHERE par.id=$1`, [ruleId]
    );
    if (!ruleRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Rule not found' }); }
    if (ruleRows[0].locked_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Version is locked' }); }

    const rule = ruleRows[0];

    // Load source line item's monthly entries
    const { rows: srcEntries } = await client.query(
      `SELECT month, year, amount FROM plan_entries
       WHERE line_item_id=$1 AND year=$2
       ORDER BY month`,
      [rule.source_line_item_id, rule.year]
    );

    // Load targets
    const { rows: targets } = await client.query(
      'SELECT * FROM plan_allocation_targets WHERE rule_id=$1 ORDER BY sort_order, id', [ruleId]
    );
    if (!targets.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Rule has no targets' }); }

    // For manual method, load existing manual results so they are preserved
    if (rule.method === 'manual') {
      const { rows: existingManual } = await client.query(
        'SELECT target_id, month, allocated_amount FROM plan_allocation_results WHERE rule_id=$1 AND is_manual=TRUE',
        [ruleId]
      );
      // Attach manual_amounts to each target
      for (const t of targets) {
        t.manual_amounts = {};
        for (const r of existingManual) {
          if (r.target_id === t.id) t.manual_amounts[r.month] = r.allocated_amount;
        }
      }
    }

    const computed = allocate(
      srcEntries.map(e => ({ month: e.month, year: e.year, amount: Number(e.amount) })),
      targets,
      rule.method
    );

    if (dryRun) {
      await client.query('ROLLBACK');
      return res.json({ dry_run: true, year: rule.year, computed });
    }

    for (const r of computed) {
      await client.query(
        `INSERT INTO plan_allocation_results
           (rule_id, target_id, month, year, source_amount, allocated_amount, is_manual, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7,NOW())
         ON CONFLICT (rule_id, target_id, month, year)
         DO UPDATE SET
           source_amount    = EXCLUDED.source_amount,
           allocated_amount = EXCLUDED.allocated_amount,
           is_manual        = FALSE,
           updated_by       = EXCLUDED.updated_by,
           updated_at       = NOW()`,
        [ruleId, r.target_id, r.month, r.year, r.source_amount, r.allocated_amount, req.user.id]
      );
    }

    await client.query('COMMIT');
    logAudit(req.user.id, 'plan.allocation.generate',
      `rule_id=${ruleId} method=${rule.method} rows=${computed.length}`, req);
    res.json({ ok: true, generated: computed.length, year: rule.year });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Save manual allocation amounts for a target
app.put('/api/plan/allocation-rules/:id/targets/:targetId/manual', requireAuth, requireAdmin, async (req, res) => {
  try {
    const ruleId   = parseInt(req.params.id);
    const targetId = parseInt(req.params.targetId);
    const { amounts = {} } = req.body; // { month: amount, ... }

    const { rows: check } = await pool.query(
      `SELECT par.id, pv.locked_at, par.method FROM plan_allocation_rules par
       JOIN plan_versions pv ON pv.id = par.version_id WHERE par.id=$1`, [ruleId]
    );
    if (!check.length) return res.status(404).json({ error: 'Rule not found' });
    if (check[0].locked_at) return res.status(409).json({ error: 'Version is locked' });
    if (check[0].method !== 'manual')
      return res.status(400).json({ error: 'Manual amounts only apply to method=manual rules' });

    const { rows: vRow } = await pool.query(
      `SELECT pv.year FROM plan_allocation_rules par
       JOIN plan_versions pv ON pv.id = par.version_id WHERE par.id=$1`, [ruleId]
    );
    const year = vRow[0]?.year;

    for (const [month, amount] of Object.entries(amounts)) {
      await pool.query(
        `INSERT INTO plan_allocation_results
           (rule_id, target_id, month, year, source_amount, allocated_amount, is_manual, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,0,$5,TRUE,$6,NOW())
         ON CONFLICT (rule_id, target_id, month, year)
         DO UPDATE SET allocated_amount=EXCLUDED.allocated_amount,
                       is_manual=TRUE, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
        [ruleId, targetId, Number(month), year, Number(amount), req.user.id]
      );
    }
    logAudit(req.user.id, 'plan.allocation.manual',
      `rule_id=${ruleId} target_id=${targetId} months=${Object.keys(amounts).length}`, req);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get allocation results for a rule
app.get('/api/plan/allocation-rules/:id/results', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT par_r.*, pat.label AS target_label, pat.entity, pat.fund_ref
       FROM plan_allocation_results par_r
       JOIN plan_allocation_targets pat ON pat.id = par_r.target_id
       WHERE par_r.rule_id=$1
       ORDER BY par_r.target_id, par_r.month`,
      [parseInt(req.params.id)]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPA FALLBACK ──────────────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

initDB()
  .then(() => app.listen(PORT, '0.0.0.0', () => log.info({ port: PORT }, 'Server started')))
  .catch(e => { log.fatal({ err: e.message }, 'DB init failed'); process.exit(1); });
