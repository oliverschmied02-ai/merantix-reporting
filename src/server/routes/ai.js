import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import rateLimit from 'express-rate-limit';
import { pool } from '../db.js';
import { log } from '../logger.js';
import { requireAdmin, logAudit } from '../middleware.js';

export const router = express.Router();

const MODEL = 'claude-opus-5-5';
const MONTHS = ['Jan', 'Feb', 'Mrz', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const MAX_DOC_BYTES = 25 * 1024 * 1024;   // API request limit is 32 MB incl. base64 overhead
const DOC_TYPES = new Set(['application/pdf', 'text/plain', 'text/markdown']);

let _client = null;
const client = () => (_client ??= new Anthropic()); // reads ANTHROPIC_API_KEY

const NO_KEY = 'Claude ist nicht eingerichtet: Die Umgebungsvariable ANTHROPIC_API_KEY fehlt auf dem Server.';

// Each analysis / extraction is a paid model call — keep it well below the general API limit.
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `ai_${req.user.id}`,
  message: { error: 'Zu viele Claude-Anfragen in kurzer Zeit. Bitte später erneut versuchen.' },
});

const num = v => (typeof v === 'number' && isFinite(v) ? Math.round(v) : null);
const clip = (s, n) => String(s ?? '').slice(0, n);

/** Map SDK errors to a user-facing HTTP response. */
function sendClaudeError(res, e, what) {
  if (e instanceof Anthropic.AuthenticationError) {
    log.error({ err: e.message }, 'Anthropic auth failed');
    return res.status(503).json({ error: 'Der hinterlegte ANTHROPIC_API_KEY ist ungültig.' });
  }
  if (e instanceof Anthropic.RateLimitError) {
    return res.status(429).json({ error: 'Claude ist gerade ausgelastet. Bitte in einer Minute erneut versuchen.' });
  }
  if (e instanceof Anthropic.APIError) {
    log.error({ status: e.status, err: e.message }, `Anthropic API error (${what})`);
    return res.status(502).json({ error: `${what} fehlgeschlagen (${e.status ?? 'Netzwerk'}): ${clip(e.message, 300)}` });
  }
  if (e instanceof SyntaxError) {
    log.error({ err: e.message }, `${what}: response was not valid JSON`);
    return res.status(502).json({ error: 'Die Antwort von Claude konnte nicht gelesen werden. Bitte erneut versuchen.' });
  }
  log.error({ err: e.message, stack: e.stack }, `${what} failed`);
  return res.status(500).json({ error: `${what} fehlgeschlagen: ${e.message}` });
}

// ── Shared context: free text + documents ─────────────────────────────

async function loadContext() {
  // Extractions interrupted by a restart would stay "pending" forever.
  await pool.query(
    `UPDATE report_documents SET status='error', error='Auswertung abgebrochen — bitte neu auswerten.', updated_at=NOW()
     WHERE status='pending' AND updated_at < NOW() - INTERVAL '15 minutes'`
  );
  const [{ rows: ctx }, { rows: docs }] = await Promise.all([
    pool.query('SELECT content, updated_at FROM report_context WHERE id=1'),
    pool.query(
      `SELECT id, filename, media_type, size_bytes, summary, status, error, created_at, updated_at
       FROM report_documents ORDER BY created_at`
    ),
  ]);
  return { content: ctx[0]?.content ?? '', updated_at: ctx[0]?.updated_at ?? null, documents: docs };
}

router.get('/api/report/context', async (req, res) => {
  try {
    res.json(await loadContext());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/api/report/context', requireAdmin, async (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  try {
    await pool.query(
      `INSERT INTO report_context (id, content, updated_by, updated_at) VALUES (1, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET content=$1, updated_by=$2, updated_at=NOW()`,
      [clip(content, 50000), req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const EXTRACT_SYSTEM = `Du bereitest Hintergrundwissen für das monatliche Management Reporting einer Fondsverwaltungs- bzw. Management-Gesellschaft vor. Aus dem Dokument entsteht eine kompakte Faktensammlung, die später bei jeder GuV-Analyse mitgegeben wird.

Extrahiere alles, was für die Interpretation der GuV der Management-Gesellschaft relevant ist, insbesondere:
- Parteien, Fonds, Struktur, Fondsgröße / Commitments, Closings
- Laufzeit, Investitionsperiode, Verlängerungen
- Management Fee: Satz, Bemessungsgrundlage (z. B. Commitments vs. investiertes Kapital), Beginn, Step-down, Zahlungsrhythmus und -zeitpunkt, Fee-Offsets / Anrechnungen
- Organisations- / Setup-Kosten (inkl. Cap), Kosten, die der Fonds trägt vs. Kosten des Managers
- Weitere wiederkehrende oder einmalige Zahlungsströme an / von der Management-Gesellschaft
- Carried Interest / Hurdle nur kurz, sofern für die GuV relevant

Regeln:
- Nur Fakten aus dem Dokument, nichts ergänzen. Fehlende Angaben weglassen statt raten.
- Fundstelle in Klammern angeben (§ oder Seite), wenn erkennbar.
- Deutsch, knapp, als Markdown mit kurzen Überschriften und Stichpunkten. Höchstens ca. 600 Wörter.`;

async function extractDocument(id) {
  try {
    const { rows } = await pool.query('SELECT filename, media_type, data FROM report_documents WHERE id=$1', [id]);
    if (!rows.length) return;
    const doc = rows[0];
    const source = doc.media_type === 'application/pdf'
      ? { type: 'base64', media_type: 'application/pdf', data: doc.data.toString('base64') }
      : { type: 'text', media_type: 'text/plain', data: doc.data.toString('utf8') };

    const response = await client().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high' },
      system: EXTRACT_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source, title: clip(doc.filename, 200) },
          { type: 'text', text: `Erstelle die Faktensammlung zu "${clip(doc.filename, 200)}".` },
        ],
      }],
    });

    if (response.stop_reason === 'refusal') throw new Error('Claude hat die Auswertung abgelehnt.');
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!text) throw new Error('Leere Antwort von Claude.');
    await pool.query(
      `UPDATE report_documents SET summary=$1, status='ready', error=NULL, updated_at=NOW() WHERE id=$2`,
      [text, id]
    );
  } catch (e) {
    log.error({ err: e.message, docId: id }, 'Document extraction failed');
    const msg = e instanceof Anthropic.AuthenticationError ? 'Der hinterlegte ANTHROPIC_API_KEY ist ungültig.'
      : e instanceof Anthropic.APIError ? `Claude-Fehler (${e.status ?? 'Netzwerk'}): ${clip(e.message, 300)}`
      : e.message;
    await pool.query(
      `UPDATE report_documents SET status='error', error=$1, updated_at=NOW() WHERE id=$2`, [msg, id]
    ).catch(() => {});
  }
}

router.post('/api/report/documents', requireAdmin, aiLimiter, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: NO_KEY });
  const { filename, media_type, data } = req.body || {};
  const type = media_type === 'text/markdown' ? 'text/markdown' : media_type;
  if (!filename || typeof data !== 'string' || !DOC_TYPES.has(type)) {
    return res.status(400).json({ error: 'Bitte eine PDF-, TXT- oder Markdown-Datei hochladen.' });
  }
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'Die Datei ist leer.' });
  if (buf.length > MAX_DOC_BYTES) return res.status(413).json({ error: 'Die Datei ist größer als 25 MB.' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO report_documents (filename, media_type, size_bytes, data, uploaded_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [clip(filename, 255), type, buf.length, buf, req.user.id]
    );
    const id = rows[0].id;
    logAudit(req.user.id, 'report.document.upload', `id=${id} file=${clip(filename, 100)} bytes=${buf.length}`, req);
    extractDocument(id); // runs in the background; the client polls the context endpoint
    res.status(202).json({ id, status: 'pending' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/report/documents/:id/extract', requireAdmin, aiLimiter, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: NO_KEY });
  const id = parseInt(req.params.id);
  const { rowCount } = await pool.query(
    `UPDATE report_documents SET status='pending', error=NULL, updated_at=NOW() WHERE id=$1`, [id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Dokument nicht gefunden' });
  extractDocument(id);
  res.status(202).json({ id, status: 'pending' });
});

router.patch('/api/report/documents/:id', requireAdmin, async (req, res) => {
  const { summary } = req.body || {};
  if (typeof summary !== 'string') return res.status(400).json({ error: 'summary required' });
  const { rowCount } = await pool.query(
    `UPDATE report_documents SET summary=$1, updated_at=NOW() WHERE id=$2`,
    [clip(summary, 50000), parseInt(req.params.id)]
  );
  if (!rowCount) return res.status(404).json({ error: 'Dokument nicht gefunden' });
  res.json({ ok: true });
});

router.delete('/api/report/documents/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { rowCount } = await pool.query('DELETE FROM report_documents WHERE id=$1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Dokument nicht gefunden' });
  logAudit(req.user.id, 'report.document.delete', `id=${id}`, req);
  res.json({ ok: true });
});

// ── Analysis ──────────────────────────────────────────────────────────

const SYSTEM = `Du bist ein erfahrener CFO / Controller und schreibst die Kommentierung für einen monatlichen Management Report auf Basis einer deutschen GuV (HGB-Gliederung, SKR04).

Arbeitsweise:
- Stütze dich auf die gelieferten Zahlen, das Hintergrundwissen zum Unternehmen / Fonds und vorhandene Kommentare. Erfinde keine Ursachen; wo die Ursache weder aus Daten noch Hintergrundwissen hervorgeht, formuliere eine Beobachtung oder eine offene Frage zur Klärung.
- Nutze das Hintergrundwissen aktiv: z. B. ob die Management Fee zur vertraglichen Erwartung (Satz × Bemessungsgrundlage, Zahlungsrhythmus) passt, oder welche Kosten der Manager trägt.
- Wenn Planzahlen vorliegen, erkläre wesentliche Abweichungen Ist vs. Plan.
- Vergleiche die ausgewählten Monate untereinander und ordne sie im YTD-Kontext ein. Nenne konkrete Beträge (gerundet, z. B. "rd. 120 T€") und Veränderungen in % wo sinnvoll. Die Kontodetails dienen der Ursachenanalyse.
- Aufwände sind in den Daten negativ dargestellt; ein betragsmäßig größerer negativer Wert bedeutet höhere Kosten.
- Schreibe auf Deutsch, sachlich und knapp, in der Sprache eines Management Reports.

Ausgabe:
- "summary": Executive Summary mit den 3–6 wichtigsten Punkten (je eine Zeile, beginnend mit "• "), inkl. Ergebnisentwicklung.
- "comments": Kommentare nur für Zeilen mit wesentlichen Bewegungen oder Auffälligkeiten (nicht für jede Zeile), jeweils 1–2 Sätze. "key" muss exakt einem Schlüssel einer Positions- oder Ergebniszeile entsprechen (keine Konto-Zeilen, also keine Schlüssel mit Kontonummer).`;

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

function buildContextBlock(ctx) {
  const parts = [];
  if (ctx.content.trim()) parts.push(`### Eigener Kontext\n${ctx.content.trim()}`);
  for (const d of ctx.documents) {
    if (d.status === 'ready' && d.summary.trim()) parts.push(`### Aus Dokument "${d.filename}"\n${d.summary.trim()}`);
  }
  return parts.join('\n\n');
}

export function buildPrompt({ year, months, rows, plan, summary, comments, company }, contextBlock = '') {
  const ytdEnd = Math.max(...months);
  const ytdHead = `YTD Jan–${MONTHS[ytdEnd - 1]}`;
  const fmt = v => (v === null || v === undefined ? '—' : String(v));
  const header = ['Schlüssel', 'Position', ytdHead, ...months.map(m => MONTHS[m - 1])];
  const lines = rows.map(r => {
    const indent = r.style === 'sub' ? '  ' : r.style === 'acct' ? '    ' : '';
    const label = indent + clip(r.label, 120) + (r.style === 'ratio' ? ' (%)' : '');
    return [r.key, label, fmt(r.ytd), ...months.map(m => fmt(r.months[m]))].join(' | ');
  });

  const planLines = plan?.rows?.length
    ? [
      '',
      `Plan (Planversion "${clip(plan.version, 120)}", gleiche Vorzeichenlogik):`,
      ['Schlüssel', ytdHead, ...months.map(m => MONTHS[m - 1])].join(' | '),
      ...plan.rows.map(r => [r.key, fmt(r.ytd), ...months.map(m => fmt(r.months[m]))].join(' | ')),
    ]
    : ['', 'Keine Planzahlen verfügbar.'];

  const existing = Object.entries(comments)
    .filter(([, c]) => c.trim())
    .map(([k, c]) => `- ${k}: ${clip(c, 1000)}`);

  return [
    contextBlock ? `## Hintergrundwissen zum Unternehmen / Fonds\n${contextBlock}\n` : '',
    `## Report`,
    `Unternehmen: ${company || 'n/a'} · Geschäftsjahr ${year}`,
    `Ausgewählte Monate: ${months.map(m => MONTHS[m - 1]).join(', ')}`,
    '',
    'GuV in EUR (Aufwand negativ; eingerückte Zeilen mit Kontonummer = Kontodetails):',
    header.join(' | '),
    ...lines,
    ...planLines,
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
  if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 1000) return null;

  const valuesOf = r => ({ ytd: num(r.ytd), months: Object.fromEntries(months.map(m => [m, num(r.months?.[m])])) });
  const rows = body.rows.map(r => ({
    key: clip(r.key, 120), label: clip(r.label, 200), style: clip(r.style, 20), ...valuesOf(r),
  }));
  const plan = Array.isArray(body.plan?.rows) && body.plan.rows.length
    ? { version: clip(body.plan.version, 120), rows: body.plan.rows.slice(0, 200).map(r => ({ key: clip(r.key, 120), ...valuesOf(r) })) }
    : null;
  const comments = {};
  for (const [k, v] of Object.entries(body.comments || {})) {
    if (typeof v === 'string') comments[clip(k, 120)] = v;
  }
  return {
    year, months, rows, plan, comments,
    summary: typeof body.summary === 'string' ? body.summary : '',
    company: clip(body.company, 200),
  };
}

router.post('/api/report/analyze', aiLimiter, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: NO_KEY });
  const input = parseBody(req.body);
  if (!input) return res.status(400).json({ error: 'Ungültige Report-Daten.' });

  try {
    const contextBlock = buildContextBlock(await loadContext());
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
      messages: [{ role: 'user', content: buildPrompt(input, contextBlock) }],
    });

    if (response.stop_reason === 'refusal') {
      return res.status(422).json({ error: 'Claude hat die Analyse abgelehnt. Bitte Auswahl prüfen und erneut versuchen.' });
    }
    if (response.stop_reason === 'max_tokens') {
      return res.status(502).json({ error: 'Die Analyse war zu lang und wurde abgeschnitten. Bitte weniger Monate auswählen.' });
    }

    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed = JSON.parse(text);

    // Only keep suggestions for position / result rows that exist in this report.
    const validKeys = new Set(input.rows.filter(r => r.style !== 'acct').map(r => r.key));
    const comments = {};
    for (const c of parsed.comments || []) {
      if (validKeys.has(c.key) && c.comment?.trim()) comments[c.key] = c.comment.trim();
    }

    logAudit(req.user.id, 'report.analyze',
      `year=${input.year} months=${input.months.join(',')} suggestions=${Object.keys(comments).length} context=${contextBlock ? 'yes' : 'no'} plan=${input.plan ? 'yes' : 'no'}`, req);
    res.json({ summary: (parsed.summary || '').trim(), comments, model: response.model, usedContext: !!contextBlock });
  } catch (e) {
    sendClaudeError(res, e, 'Claude-Analyse');
  }
});
