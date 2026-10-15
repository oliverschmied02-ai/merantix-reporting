import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import rateLimit from 'express-rate-limit';
import { log } from '../logger.js';
import { logAudit } from '../middleware.js';

export const router = express.Router();

const MODEL = 'claude-opus-5-5';
const MONTHS = ['Jan', 'Feb', 'Mrz', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

let _client = null;
const client = () => (_client ??= new Anthropic()); // reads ANTHROPIC_API_KEY

// Each analysis is a paid model call — keep it well below the general API limit.
const analyzeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `ai_${req.user.id}`,
  message: { error: 'Zu viele Analysen in kurzer Zeit. Bitte später erneut versuchen.' },
});

const SYSTEM = `Du bist ein erfahrener CFO / Controller und schreibst die Kommentierung für einen monatlichen Management Report auf Basis einer deutschen GuV (HGB-Gliederung, SKR04).

Arbeitsweise:
- Stütze dich ausschließlich auf die gelieferten Zahlen und vorhandenen Kommentare. Erfinde keine Ursachen; wo die Ursache aus den Daten nicht hervorgeht, formuliere eine Beobachtung oder eine offene Frage zur Klärung.
- Vergleiche die ausgewählten Monate untereinander und ordne sie im YTD-Kontext ein. Nenne konkrete Beträge (gerundet, z. B. "rd. 120 T€") und Veränderungen in % wo sinnvoll.
- Aufwände sind in den Daten negativ dargestellt; ein betragsmäßig größerer negativer Wert bedeutet höhere Kosten.
- Schreibe auf Deutsch, sachlich und knapp, in der Sprache eines Management Reports.

Ausgabe:
- "summary": Executive Summary mit den 3–6 wichtigsten Punkten (je eine Zeile, beginnend mit "• "), inkl. Ergebnisentwicklung.
- "comments": Kommentare nur für Zeilen mit wesentlichen Bewegungen oder Auffälligkeiten (nicht für jede Zeile), jeweils 1–2 Sätze. "key" muss exakt einem Schlüssel aus der Tabelle entsprechen.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, comment: { type: 'string' } },
        required: ['key', 'comment'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'comments'],
  additionalProperties: false,
};

const num = v => (typeof v === 'number' && isFinite(v) ? Math.round(v) : null);
const clip = (s, n) => String(s ?? '').slice(0, n);

function buildPrompt({ year, months, rows, summary, comments, company }) {
  const ytdEnd = Math.max(...months);
  const header = ['Schlüssel', 'Position', `YTD Jan–${MONTHS[ytdEnd - 1]}`, ...months.map(m => MONTHS[m - 1])];
  const lines = rows.map(r => {
    const fmt = v => (v === null ? '—' : String(v));
    const label = (r.style === 'sub' ? '  ' : '') + clip(r.label, 120) + (r.style === 'ratio' ? ' (%)' : '');
    return [r.key, label, fmt(r.ytd), ...months.map(m => fmt(r.months[m]))].join(' | ');
  });

  const existing = Object.entries(comments)
    .filter(([, c]) => c.trim())
    .map(([k, c]) => `- ${k}: ${clip(c, 1000)}`);

  return [
    `Unternehmen: ${company || 'n/a'} · Geschäftsjahr ${year}`,
    `Ausgewählte Monate: ${months.map(m => MONTHS[m - 1]).join(', ')}`,
    '',
    'GuV in EUR (Aufwand negativ):',
    header.join(' | '),
    ...lines,
    '',
    existing.length ? `Bereits vorhandene Kommentare des Nutzers:\n${existing.join('\n')}` : 'Noch keine Kommentare vorhanden.',
    summary.trim() ? `\nBisherige Zusammenfassung des Nutzers:\n${clip(summary, 4000)}` : '',
    '',
    'Analysiere die ausgewählten Monate und liefere Executive Summary und Kommentarvorschläge.',
  ].join('\n');
}

function parseBody(body) {
  const year = parseInt(body?.year);
  const months = [...new Set((body?.months || []).map(Number))]
    .filter(m => Number.isInteger(m) && m >= 1 && m <= 12)
    .sort((a, b) => a - b);
  if (!year || !months.length) return null;
  if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 300) return null;

  const rows = body.rows.map(r => ({
    key: clip(r.key, 120),
    label: clip(r.label, 200),
    style: clip(r.style, 20),
    ytd: num(r.ytd),
    months: Object.fromEntries(months.map(m => [m, num(r.months?.[m])])),
  }));
  const comments = {};
  for (const [k, v] of Object.entries(body.comments || {})) {
    if (typeof v === 'string') comments[clip(k, 120)] = v;
  }
  return {
    year, months, rows, comments,
    summary: typeof body.summary === 'string' ? body.summary : '',
    company: clip(body.company, 200),
  };
}

router.post('/api/report/analyze', analyzeLimiter, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: 'Claude-Analyse ist nicht eingerichtet: Die Umgebungsvariable ANTHROPIC_API_KEY fehlt auf dem Server.',
    });
  }
  const input = parseBody(req.body);
  if (!input) return res.status(400).json({ error: 'Ungültige Report-Daten.' });

  try {
    const response = await client().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      },
      system: SYSTEM,
      messages: [{ role: 'user', content: buildPrompt(input) }],
    });

    if (response.stop_reason === 'refusal') {
      return res.status(422).json({ error: 'Claude hat die Analyse abgelehnt. Bitte Auswahl prüfen und erneut versuchen.' });
    }
    if (response.stop_reason === 'max_tokens') {
      return res.status(502).json({ error: 'Die Analyse war zu lang und wurde abgeschnitten. Bitte weniger Monate auswählen.' });
    }

    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed = JSON.parse(text);

    // Only keep suggestions for rows that exist in this report.
    const validKeys = new Set(input.rows.map(r => r.key));
    const comments = {};
    for (const c of parsed.comments || []) {
      if (validKeys.has(c.key) && c.comment?.trim()) comments[c.key] = c.comment.trim();
    }

    logAudit(req.user.id, 'report.analyze',
      `year=${input.year} months=${input.months.join(',')} suggestions=${Object.keys(comments).length}`, req);
    res.json({ summary: (parsed.summary || '').trim(), comments, model: response.model });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      log.error({ err: e.message }, 'Anthropic auth failed');
      return res.status(503).json({ error: 'Der hinterlegte ANTHROPIC_API_KEY ist ungültig.' });
    }
    if (e instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Claude ist gerade ausgelastet. Bitte in einer Minute erneut versuchen.' });
    }
    if (e instanceof Anthropic.APIError) {
      log.error({ status: e.status, err: e.message }, 'Anthropic API error');
      return res.status(502).json({ error: `Claude-Analyse fehlgeschlagen (${e.status ?? 'Netzwerk'}).` });
    }
    if (e instanceof SyntaxError) {
      log.error({ err: e.message }, 'Analysis response was not valid JSON');
      return res.status(502).json({ error: 'Die Antwort von Claude konnte nicht gelesen werden. Bitte erneut versuchen.' });
    }
    log.error({ err: e.message, stack: e.stack }, 'Report analysis failed');
    res.status(500).json({ error: 'Analyse fehlgeschlagen: ' + e.message });
  }
});
