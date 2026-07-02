import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { JWT_SECRET, COOKIE_NAME, COOKIE_OPTS } from '../config.js';
import { requireAuth, logAudit, validateEmail, validatePassword } from '../middleware.js';
import { loginLimiter, requestAccessLimiter, apiLimiter } from '../rate-limits.js';

export const router = express.Router();

router.post('/api/auth/login', loginLimiter, async (req, res) => {
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

router.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTS, maxAge: 0 });
  res.json({ ok: true });
});

// ── ACCESS REQUESTS (public) ──────────────────────────────────────────
router.post('/api/auth/request-access', requestAccessLimiter, async (req, res) => {
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

// apiLimiter preserved here: this route sat behind the global /api gate in the
// monolith. Registered before the gate now, so the limiter is applied explicitly.
router.patch('/api/auth/me/password', requireAuth, apiLimiter, async (req, res) => {
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
