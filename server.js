import express from 'express';
import pg from 'pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

// ── DB INIT ───────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           SERIAL PRIMARY KEY,
      email        TEXT UNIQUE NOT NULL,
      name         TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
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
      id          SERIAL PRIMARY KEY,
      file_id     TEXT REFERENCES gdpdu_files(id) ON DELETE CASCADE,
      ktonr       INTEGER,
      gktonr      INTEGER,
      soll        NUMERIC,
      haben       NUMERIC,
      datum       DATE,
      text        TEXT,
      beleg       TEXT,
      wj_month    INTEGER,
      wj_year     INTEGER,
      stapel_raw  TEXT
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
  `);

  // Add role column if it doesn't exist yet (migration)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'viewer'`);
  // Ensure the first user (env-bootstrapped admin) keeps admin role
  await pool.query(`UPDATE users SET role='admin' WHERE id=(SELECT MIN(id) FROM users) AND role IS NULL`);

  // Create initial admin from env vars if no users exist yet
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(rows[0].count) === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
    await pool.query(
      'INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4)',
      [process.env.ADMIN_EMAIL, process.env.ADMIN_NAME || 'Admin', hash, 'admin']
    );
    console.log(`✓ Created admin: ${process.env.ADMIN_EMAIL}`);
  }
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
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

// ── AUTH ROUTES ───────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
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
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ── ACCESS REQUESTS ───────────────────────────────────────────────────
app.post('/api/auth/request-access', async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name und E-Mail erforderlich' });
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
    res.json({ user: ins.rows[0], tempPassword });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('unique') ? 'E-Mail bereits registriert' : e.message });
  }
});

app.delete('/api/users/requests/:id', requireAuth, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM access_requests WHERE id=$1', [req.params.id]);
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
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role',
      [email.toLowerCase(), name, hash, role === 'admin' ? 'admin' : 'viewer']
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: e.message.includes('unique') ? 'Email bereits vergeben' : e.message });
  }
});

// Own password change — any authenticated user
app.patch('/api/auth/me/password', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Passwort zu kurz (min. 6 Zeichen)' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: reset any user's password
app.patch('/api/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 4) return res.status(400).json({ error: 'Passwort zu kurz' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
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
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ── DATA: LOAD ALL ────────────────────────────────────────────────────
app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const files = await pool.query(
      'SELECT gf.*, u.name as uploader_name FROM gdpdu_files gf LEFT JOIN users u ON gf.uploaded_by = u.id ORDER BY gf.uploaded_at'
    );
    if (files.rows.length === 0) return res.json(null);

    const txns   = await pool.query(`
      SELECT t.*, dm.item_id AS dm_item_id, dm.sub_id AS dm_sub_id
      FROM transactions t
      LEFT JOIN direct_mappings dm ON dm.txn_id = t.id
      ORDER BY t.id
    `);
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
      `INSERT INTO gdpdu_files (id, name, company_name, uploaded_by, uploaded_at, txn_count, years)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [file.id, file.name, file.companyName || null, req.user.id, file.uploadedAt, file.txnCount, JSON.stringify(file.years)]
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
  res.json({ ok: true });
});

// ── DATA: CLEAR ALL ───────────────────────────────────────────────────
app.delete('/api/data', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM gdpdu_files'); // cascades to transactions
  await pool.query('DELETE FROM account_names');
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

// ── SPA FALLBACK ──────────────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

initDB()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`✓ Running on port ${PORT}`)))
  .catch(e => { console.error('DB init failed:', e); process.exit(1); });
