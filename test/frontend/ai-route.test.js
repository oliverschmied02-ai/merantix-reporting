// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { create, query } = vi.hoisted(() => ({ create: vi.fn(), query: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  class AuthenticationError extends APIError {}
  class RateLimitError extends APIError {}
  class Anthropic {
    constructor() { this.beta = { messages: { create: (...a) => create(...a) } }; }
  }
  Object.assign(Anthropic, { APIError, AuthenticationError, RateLimitError });
  return { default: Anthropic };
});
vi.mock('../../src/server/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));
vi.mock('../../src/server/middleware.js', () => ({ logAudit: vi.fn(), requireAdmin: (req, res, next) => next() }));
vi.mock('../../src/server/db.js', () => ({ pool: { query: (...a) => query(...a) } }));

// Fake DB: shared context + one summarised document.
function fakeDb() {
  query.mockImplementation(async sql => {
    if (sql.includes('FROM report_context')) return { rows: [{ content: 'Management Fee 2 % p.a. auf Commitments', updated_at: null }] };
    if (sql.includes('FROM report_documents ORDER BY')) {
      return { rows: [
        { id: 1, filename: 'LPA Fund II.pdf', status: 'ready', summary: 'Fee quartalsweise im Voraus (§ 8)' },
        { id: 2, filename: 'Entwurf.pdf', status: 'pending', summary: '' },
      ] };
    }
    if (sql.startsWith('INSERT INTO report_documents')) return { rows: [{ id: 3 }] };
    if (sql.startsWith('SELECT filename, media_type, data')) {
      return { rows: [{ filename: 'LPA.pdf', media_type: 'application/pdf', data: Buffer.from('%PDF-1.4 test') }] };
    }
    return { rows: [], rowCount: 1 };
  });
}

import Anthropic from '@anthropic-ai/sdk';
import { router } from '../../src/server/routes/ai.js';

// Call a route's final handler directly (skips rate limiter / admin check).
const handlerFor = (method, path) => router.stack
  .find(l => l.route?.path === path && l.route.methods[method]).route.stack.at(-1).handle;
const handler = handlerFor('post', '/api/report/analyze');

async function call(body, h = handler) {
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await h({ body, user: { id: 1 }, params: {} }, res);
  return res;
}

const BODY = {
  year: 2026,
  months: [3, 2],
  company: 'Merantix',
  summary: '',
  comments: { revenue: 'Fund II Closing' },
  rows: [
    { key: 'revenue', label: 'Umsatzerlöse & Erträge', style: 'section', ytd: 230000, months: { 2: 80000, 3: 100000 } },
    { key: 'opex::opex_ext', label: 'Fremdleistungen', style: 'sub', ytd: -30000, months: { 2: 0, 3: -30000 } },
  ],
};

const reply = obj => ({
  stop_reason: 'end_turn', model: 'claude-opus-5-5',
  content: [{ type: 'text', text: JSON.stringify(obj) }],
});

describe('POST /api/report/analyze', () => {
  beforeEach(() => {
    create.mockReset();
    fakeDb();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('returns 503 when no API key is configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await call(BODY);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toContain('ANTHROPIC_API_KEY');
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects malformed report data', async () => {
    expect((await call({ year: 2026, months: [], rows: [] })).statusCode).toBe(400);
  });

  it('calls Claude with structured output and filters suggestions to known rows', async () => {
    create.mockResolvedValue(reply({
      summary: '• Umsatz steigt',
      comments: [
        { key: 'revenue', comment: 'Anstieg um 25 %.' },
        { key: 'does_not_exist', comment: 'ignore me' },
      ],
    }));
    const res = await call(BODY);

    const params = create.mock.calls[0][0];
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.output_config.format.type).toBe('json_schema');
    const prompt = params.messages[0].content;
    expect(prompt).toContain('Ausgewählte Monate: Feb, Mrz');
    expect(prompt).toContain('YTD Jan–Mrz');
    expect(prompt).toContain('opex::opex_ext |   Fremdleistungen | -30000 | 0 | -30000');
    expect(prompt).toContain('- revenue: Fund II Closing');
    // Shared context and ready document summaries are included; pending ones are not.
    expect(prompt).toContain('Management Fee 2 % p.a. auf Commitments');
    expect(prompt).toContain('### Aus Dokument "LPA Fund II.pdf"\nFee quartalsweise im Voraus (§ 8)');
    expect(prompt).not.toContain('Entwurf.pdf');
    expect(prompt).toContain('Keine Planzahlen verfügbar.');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      summary: '• Umsatz steigt',
      comments: { revenue: 'Anstieg um 25 %.' },
      model: 'claude-opus-5-5',
      usedContext: true,
    });
  });

  it('includes plan figures when a plan version is sent', async () => {
    create.mockResolvedValue(reply({ summary: 's', comments: [] }));
    await call({ ...BODY, plan: { version: 'Budget 2026', rows: [{ key: 'revenue', ytd: 270000, months: { 2: 90000, 3: 90000 } }] } });
    const prompt = create.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Plan (Planversion "Budget 2026"');
    expect(prompt).toContain('revenue | 270000 | 90000 | 90000');
  });

  it('never accepts suggestions for account detail rows', async () => {
    create.mockResolvedValue(reply({ summary: 's', comments: [{ key: 'opex::opex_ext::630300', comment: 'x' }] }));
    const res = await call({
      ...BODY,
      rows: [...BODY.rows, { key: 'opex::opex_ext::630300', label: '630300 · Beratung', style: 'acct', ytd: -30000, months: { 3: -30000 } }],
    });
    expect(res.body.comments).toEqual({});
  });

  it('maps a refusal to 422', async () => {
    create.mockResolvedValue({ stop_reason: 'refusal', content: [] });
    expect((await call(BODY)).statusCode).toBe(422);
  });

  it('maps API rate limits to 429', async () => {
    create.mockRejectedValue(new Anthropic.RateLimitError(429, 'rate limited'));
    expect((await call(BODY)).statusCode).toBe(429);
  });
});

describe('report documents', () => {
  const upload = handlerFor('post', '/api/report/documents');

  beforeEach(() => {
    create.mockReset();
    fakeDb();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('rejects unsupported file types', async () => {
    const res = await call({ filename: 'LPA.docx', media_type: 'application/msword', data: 'AAAA' }, upload);
    expect(res.statusCode).toBe(400);
  });

  it('stores a PDF and summarises it with Claude in the background', async () => {
    create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: '## Management Fee\n- 2 % p.a.' }] });
    const res = await call({ filename: 'LPA.pdf', media_type: 'application/pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') }, upload);
    expect(res.statusCode).toBe(202);
    await new Promise(r => setTimeout(r, 0));

    const params = create.mock.calls[0][0];
    expect(params.messages[0].content[0]).toMatchObject({
      type: 'document', source: { type: 'base64', media_type: 'application/pdf' },
    });
    const saveCall = query.mock.calls.find(([sql]) => sql.startsWith("UPDATE report_documents SET summary=$1, status='ready'"));
    expect(saveCall[1]).toEqual(['## Management Fee\n- 2 % p.a.', 3]);
  });
});
