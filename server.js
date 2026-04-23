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

// ── SPA FALLBACK ──────────────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

initDB()
  .then(() => app.listen(PORT, '0.0.0.0', () => log.info({ port: PORT }, 'Server started')))
  .catch(e => { log.fatal({ err: e.message }, 'DB init failed'); process.exit(1); });
