import rateLimit from 'express-rate-limit';

// Authenticated API limiter: 300 req/min per user, applied after requireAuth sets req.user.
// Used on all data/mapping/user-management routes so bulk operations can't hammer the DB.
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `user_${req.user.id}`,
  message: { error: 'Zu viele Anfragen. Bitte kurz warten.' },
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.' },
});

export const requestAccessLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen von dieser IP. Bitte später erneut versuchen.' },
});
