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
  `);

  // Create initial admin from env vars if no users exist yet
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(rows[0].count) === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
    await pool.query(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)',
      [process.env.ADMIN_EMAIL, process.env.ADMIN_NAME || 'Admin', hash]
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
      { id: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ── USER MANAGEMENT ───────────────────────────────────────────────────
app.get('/api/users', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, email, name, created_at FROM users ORDER BY id');
  res.json(rows);
});

app.post('/api/users', requireAuth, async (req, res) => {
  try {
    const { email, name, password } = req.body;
    if (!email || !name || !password) return res.status(400).json({ error: 'email, name, password required' });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email.toLowerCase(), name, hash]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: e.message.includes('unique') ? 'Email bereits vergeben' : e.message });
  }
});

app.patch('/api/users/:id/password', requireAuth, async (req, res) => {
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

app.delete('/api/users/:id', requireAuth, async (req, res) => {
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

    const txns   = await pool.query('SELECT * FROM transactions ORDER BY id');
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

// ── SPA FALLBACK ──────────────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

initDB()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`✓ Running on port ${PORT}`)))
  .catch(e => { console.error('DB init failed:', e); process.exit(1); });
