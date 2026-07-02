import { log } from './logger.js';

export const PORT = process.env.PORT || 3000;

if (!process.env.JWT_SECRET) {
  log.fatal('JWT_SECRET environment variable is not set');
  process.exit(1);
}
export const JWT_SECRET = process.env.JWT_SECRET;

// Session cookie config — httpOnly so tokens are never exposed to JS.
export const COOKIE_NAME = 'gdpdu_session';
export const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};

export function buildSslConfig() {
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
