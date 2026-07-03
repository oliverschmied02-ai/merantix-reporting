import jwt from 'jsonwebtoken';
import { pool } from './db.js';
import { log } from './logger.js';
import { JWT_SECRET, COOKIE_NAME } from './config.js';

export function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME] ?? req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token expired or invalid' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Keine Berechtigung' });
  next();
}

const MIN_PASSWORD_LENGTH = 12;
export function validatePassword(password) {
  if (!password || password.length < MIN_PASSWORD_LENGTH)
    return `Passwort zu kurz (min. ${MIN_PASSWORD_LENGTH} Zeichen)`;
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validateEmail(email) {
  if (!email || !EMAIL_RE.test(email)) return 'Ungültige E-Mail-Adresse';
  return null;
}

export function logAudit(userId, action, detail, req) {
  const ip = req?.headers?.['x-forwarded-for']?.split(',')[0].trim() ?? req?.socket?.remoteAddress ?? null;
  pool.query(
    'INSERT INTO audit_log (user_id, action, detail, ip) VALUES ($1, $2, $3, $4)',
    [userId ?? null, action, detail ?? null, ip]
  ).catch(err => log.error({ err: err.message }, 'Audit log write failed'));
}
