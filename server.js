import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';

import { log } from './src/server/logger.js';
import { PORT } from './src/server/config.js';
import { pool } from './src/server/db.js';
import { initDB } from './src/server/migrations.js';
import { requireAuth } from './src/server/middleware.js';
import { apiLimiter } from './src/server/rate-limits.js';

import { router as authRoutes } from './src/server/routes/auth.js';
import { router as usersRoutes } from './src/server/routes/users.js';
import { router as dataRoutes } from './src/server/routes/data.js';
import { router as planRoutes } from './src/server/routes/plan.js';
import { router as driverRoutes } from './src/server/routes/drivers.js';
import { router as allocationRoutes } from './src/server/routes/allocation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(helmet({
  // CSP is now enforced. Inline on*= handlers were migrated to event
  // delegation (src/ui/dispatch.js), so script-src can be strict 'self' with
  // no 'unsafe-inline' — the key XSS defense. Inline style= attributes remain
  // (149 of them) so style-src keeps 'unsafe-inline'; styles can't execute
  // code. Google Fonts is served from the documented CDN hosts.
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc:     ["'self'"],
      baseUri:        ["'self'"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
      formAction:     ["'self'"],
      scriptSrc:      ["'self'"],
      scriptSrcAttr:  ["'none'"], // hard-block inline event handlers (defense in depth)
      styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:        ["'self'", "https://fonts.gstatic.com"],
      imgSrc:         ["'self'", "data:"],
      connectSrc:     ["'self'"],
      // Only upgrade to HTTPS in production; would break local http testing.
      ...(process.env.NODE_ENV === 'production' ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  crossOriginEmbedderPolicy: false,
  // All other helmet defaults remain: HSTS, X-Frame-Options: DENY,
  // X-Content-Type-Options: nosniff, Referrer-Policy, X-DNS-Prefetch-Control
}));
app.use(express.json({ limit: '100mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'dist'), {
  setHeaders(res, filePath) {
    // index.html must always be revalidated so it points at the current
    // (hashed) bundle; hashed assets are immutable and cached for a year.
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api') || req.path === '/health') {
      log.info({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
    }
  });
  next();
});

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

// ── PUBLIC + SELF AUTH ROUTES ─────────────────────────────────────────
// Mounted before the /api gate so login / logout / request-access stay public.
// (Self routes like /api/auth/me carry their own requireAuth.)
app.use(authRoutes);

// Gate: every /api route below requires authentication and is per-user rate limited.
app.use('/api', requireAuth, apiLimiter);

// ── PROTECTED API ROUTES ──────────────────────────────────────────────
app.use(usersRoutes);
app.use(dataRoutes);
app.use(planRoutes);
app.use(driverRoutes);
app.use(allocationRoutes);

// ── SPA FALLBACK ──────────────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache'); // always revalidate the shell
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

initDB()
  .then(() => app.listen(PORT, '0.0.0.0', () => log.info({ port: PORT }, 'Server started')))
  .catch(e => { log.fatal({ err: e.message, stack: e.stack }, 'DB init failed'); process.exit(1); });
