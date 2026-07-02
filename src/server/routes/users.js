import express from 'express';
import bcrypt from 'bcrypt';
import { pool } from '../db.js';
import { requireAuth, requireAdmin, logAudit, validateEmail, validatePassword } from '../middleware.js';

export const router = express.Router();

router.get('/api/users/requests', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM access_requests ORDER BY created_at DESC');
  res.json(rows);
});

router.post('/api/users/requests/:id/approve', requireAuth, requireAdmin, async (req, res) => {
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

router.delete('/api/users/requests/:id', requireAuth, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM access_requests WHERE id=$1', [req.params.id]);
  logAudit(req.user.id, 'access_request.reject', `request_id=${req.params.id}`, req);
  res.json({ ok: true });
});

// ── USER MANAGEMENT ───────────────────────────────────────────────────
router.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id, email, name, role, created_at FROM users ORDER BY id');
  res.json(rows);
});

router.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
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

router.patch('/api/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
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
router.patch('/api/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
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

router.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  logAudit(req.user.id, 'user.delete', `target_user_id=${req.params.id}`, req);
  res.json({ ok: true });
});
