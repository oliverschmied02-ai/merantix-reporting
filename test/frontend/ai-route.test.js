// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));

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
vi.mock('../../src/server/middleware.js', () => ({ logAudit: vi.fn() }));

import Anthropic from '@anthropic-ai/sdk';
import { router } from '../../src/server/routes/ai.js';

// Call the route's final handler directly (skips the rate limiter).
const handler = router.stack.find(l => l.route?.path === '/api/report/analyze').route.stack.at(-1).handle;

async function call(body) {
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await handler({ body, user: { id: 1 } }, res);
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

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      summary: '• Umsatz steigt',
      comments: { revenue: 'Anstieg um 25 %.' },
      model: 'claude-opus-5-5',
    });
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
