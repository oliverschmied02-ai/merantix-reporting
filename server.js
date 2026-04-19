import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Railway persistent volume mounts at /data; fallback to local ./data for dev
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'app-data.json');

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

// ── Load saved data ──────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.json(null); // no data yet
  }
});

// ── Save data ────────────────────────────────────────────────
app.post('/api/data', async (req, res) => {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(req.body));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Clear data ───────────────────────────────────────────────
app.delete('/api/data', async (req, res) => {
  try { await fs.unlink(DATA_FILE); } catch {}
  res.json({ ok: true });
});

// ── SPA fallback ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`GDPdU P&L Analyzer running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
