import { describe, it, expect, beforeEach, vi } from 'vitest';

// Settings API records saves; the analysis endpoint returns canned suggestions.
const saved = {};
const analyzeReport = vi.fn();
const { openDrillTxns } = vi.hoisted(() => ({ openDrillTxns: vi.fn() }));
vi.mock('../../src/lib/db.js', () => ({
  getSetting: vi.fn(async key => saved[key] ?? null),
  saveSetting: vi.fn(async (key, value) => { saved[key] = value; }),
  loadTransactionsForYear: vi.fn(async () => []),
  analyzeReport: (...a) => analyzeReport(...a),
  getPlanVersions: vi.fn(async () => [{ id: 7, year: 2026, name: 'Budget 2026', type: 'budget' }]),
  getPlanLineItems: vi.fn(async () => [
    { id: 1, category: 'revenue', item_id: 'revenue' },
    { id: 2, category: 'opex', item_id: 'opex_ext' },
  ]),
  getPlanEntries: vi.fn(async () => [
    { line_item_id: 1, month: 3, amount: 90000 },
    { line_item_id: 2, month: 3, amount: 40000 },
  ]),
}));
vi.mock('../../src/ui/drill.js', () => ({ openDrillTxns }));

import { APP, resetAPP } from '../../src/state.js';
import { rebuildAcctMap } from '../../src/lib/resolve.js';
import { ensureTaxSection } from '../../src/lib/storage.js';
import { DEFAULT_PL_DEF } from '../../src/data/default-pl.js';
import { deepClone } from '../../src/lib/utils.js';
import {
  openReportScreen, mrChangeYear, mrCommentInput, mrToggleMonth, mrPreset,
  mrAnalyze, mrAcceptAllComments, mrAcceptSummary,
  mrToggleSection, mrToggleSub, mrDrill, mrChangePlan,
} from '../../src/ui/mgmt-report.js';

const flush = () => new Promise(r => setTimeout(r, 0));

const txn = (ktonr, soll, haben, wjMonth) => ({
  ktonr, gktonr: 120000, soll, haben, datum: new Date(2026, wjMonth - 1, 15),
  text: 't', beleg: 'B', wjMonth, wjYear: 2026,
});

describe('ensureTaxSection', () => {
  const legacy = () => deepClone(DEFAULT_PL_DEF).filter(i => i.id !== 'taxes' && i.id !== 'net_income');

  it('inserts taxes + net income directly below EBT', () => {
    const def = legacy();
    expect(ensureTaxSection(def)).toBe(true);
    const ids = def.map(i => i.id);
    expect(ids.slice(ids.indexOf('ebt'), ids.indexOf('ebt') + 3)).toEqual(['ebt', 'taxes', 'net_income']);
  });

  it('keeps accounts the user already mapped elsewhere', () => {
    const def = legacy();
    def.find(i => i.id === 'revenue').subs.find(s => s.id === 'rev_other').accounts.push(764300);
    ensureTaxSection(def);
    const taxAccts = def.find(i => i.id === 'taxes').subs.flatMap(s => s.accounts);
    expect(taxAccts).not.toContain(764300);
    expect(taxAccts).toContain(760000);
  });

  it('is a no-op once the section exists', () => {
    expect(ensureTaxSection(deepClone(DEFAULT_PL_DEF))).toBe(false);
  });
});

describe('Management report', () => {
  const rows = () => [...document.querySelectorAll('#mr-content tbody tr')];
  const row = label => rows().find(tr => tr.querySelector('.mr-label')?.textContent === label);
  const nums = tr => [...tr.querySelectorAll('.mr-num')].map(td => td.textContent.trim());
  const headers = () => [...document.querySelectorAll('#mr-content thead th')].map(th => th.textContent.trim());

  beforeEach(async () => {
    for (const k of Object.keys(saved)) delete saved[k];
    analyzeReport.mockReset();
    resetAPP();
    APP.years = [2026];
    APP.loadedYears = new Set([2026]);
    APP.allTransactions = [
      txn(440000, 0, 50000, 1),    // revenue 50k Jan
      txn(440000, 0, 80000, 2),    // revenue 80k Feb
      txn(440000, 0, 100000, 3),   // revenue 100k Mar
      txn(630300, 30000, 0, 3),    // opex 30k Mar
      txn(760000, 20000, 0, 3),    // Körperschaftsteuer 20k Mar
    ];
    rebuildAcctMap();
    APP.accountNames = new Map([[630300, 'Fremdleistungen Beratung']]);
    openDrillTxns.mockReset();
    document.body.innerHTML = `
      <div id="toast"></div>
      <select id="year-sel"><option value="2026" selected>2026</option></select>
      <select id="mr-year-sel"></select>
      <select id="mr-plan-sel"></select>
      <button id="mr-analyze-btn"></button>
      <span id="mr-save-status"></span>
      <div id="mr-content"></div>`;
    await openReportScreen();
    await mrChangeYear(); // module keeps the selection across visits — reset to the default (latest month)
  });

  it('defaults to the latest month: YTD left, month right, taxes below EBT', () => {
    expect(headers()).toEqual(['Position', 'YTD Jan–Mrz', 'Mrz', 'Kommentar']);
    const all = rows();
    expect(all.indexOf(row('Steuern vom Einkommen und Ertrag'))).toBe(all.indexOf(row('EBT (Ergebnis vor Steuern)')) + 1);
    // YTD: 230k − 30k − 20k = 180k; Mar: 100k − 30k − 20k = 50k
    expect(nums(row('Jahresergebnis (nach Steuern)'))).toEqual(['180.000', '50.000']);
    expect(nums(row('Steuern vom Einkommen und Ertrag'))).toEqual(['−20.000', '−20.000']);
    expect(rows().every(tr => tr.querySelector('textarea.mr-comment-input'))).toBe(true);
  });

  it('supports multiple months, keeping YTD first', async () => {
    await mrToggleMonth(1);
    expect(headers()).toEqual(['Position', 'YTD Jan–Mrz', 'Jan', 'Mrz', 'Kommentar']);
    await mrPreset('Q1');
    expect(headers()).toEqual(['Position', 'YTD Jan–Mrz', 'Jan', 'Feb', 'Mrz', 'Kommentar']);
    expect(nums(row('Umsatzerlöse & Erträge'))).toEqual(['230.000', '50.000', '80.000', '100.000']);
  });

  it('never deselects the last remaining month', async () => {
    await mrToggleMonth(3);
    expect(headers()).toEqual(['Position', 'YTD Jan–Mrz', 'Mrz', 'Kommentar']);
  });

  it('auto-saves comments per year + month selection', async () => {
    vi.useFakeTimers();
    const ta = document.querySelector('#mr-content textarea.mr-comment-input');
    ta.value = 'Umsatz über Plan wegen Fund II Closing';
    mrCommentInput('revenue', ta);
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    await flush();
    expect(saved['mgmt_report_v1_2026_M3']?.comments?.revenue).toBe('Umsatz über Plan wegen Fund II Closing');
  });

  it('sends the selection to Claude and applies suggestions without overwriting', async () => {
    saved['mgmt_report_v1_2026_M2-3'] = { summary: '', comments: { revenue: 'Eigener Kommentar' } };
    await mrPreset('Q1');          // loads M1-2-3 (empty)
    await mrToggleMonth(1);        // → M2-3, which has the user's own revenue comment

    analyzeReport.mockResolvedValue({
      summary: '• Umsatz +25 % ggü. Vormonat',
      comments: { revenue: 'Starker Anstieg im März.', 'opex::opex_ext': 'Erstmals Fremdleistungen.' },
    });
    await mrAnalyze();

    const payload = analyzeReport.mock.calls[0][0];
    expect(payload.months).toEqual([2, 3]);
    expect(payload.rows.find(r => r.key === 'revenue').months).toEqual({ 2: 80000, 3: 100000 });
    expect(document.querySelector('.mr-ai-text').textContent).toContain('Umsatz +25 %');

    mrAcceptAllComments();
    const val = key => document.querySelector(`[data-input-args*='"${key}"']`).value;
    expect(val('opex::opex_ext')).toBe('Erstmals Fremdleistungen.'); // empty → filled
    expect(val('revenue')).toBe('Eigener Kommentar');                 // user text kept

    mrAcceptSummary();
    expect(document.getElementById('mr-summary').value).toBe('• Umsatz +25 % ggü. Vormonat');
  });

  it('expands sub-groups to accounts and collapses sections, like the P&L view', async () => {
    expect(row('630300 · Fremdleistungen Beratung')).toBeUndefined();
    mrToggleSub('opex::opex_ext');
    expect(nums(row('630300 · Fremdleistungen Beratung'))).toEqual(['−30.000', '−30.000']);
    mrToggleSection('opex');
    expect(row('Fremdleistungen')).toBeUndefined();
    expect(row('630300 · Fremdleistungen Beratung')).toBeUndefined();
    mrToggleSection('opex');
    mrToggleSub('opex::opex_ext');
  });

  it('opens the bookings behind a number', async () => {
    mrDrill('opex::opex_ext::630300', 3);
    let arg = openDrillTxns.mock.calls.at(-1)[0];
    expect(arg.title).toBe('630300 · Fremdleistungen Beratung');
    expect(arg.period).toBe('Mrz 2026');
    expect(arg.txns.map(t => t.ktonr)).toEqual([630300]);

    mrDrill('revenue', 0); // section, YTD → all revenue bookings Jan–Mar
    arg = openDrillTxns.mock.calls.at(-1)[0];
    expect(arg.period).toBe('YTD Jan–Mrz 2026');
    expect(arg.txns).toHaveLength(3);
  });

  it('sends all accounts and the selected plan (costs negative) to the analysis', async () => {
    analyzeReport.mockResolvedValue({ summary: 'ok', comments: {}, usedContext: true });
    await mrAnalyze();
    const p = analyzeReport.mock.calls[0][0];
    expect(p.rows.some(r => r.key === 'opex::opex_ext::630300' && r.style === 'acct')).toBe(true);
    expect(p.plan.version).toBe('Budget 2026');
    const plan = Object.fromEntries(p.plan.rows.map(r => [r.key, r.months[3]]));
    expect(plan).toMatchObject({ revenue: 90000, opex: -40000, 'opex::opex_ext': -40000, ebitda: 50000 });
    expect(document.querySelector('.mr-ai-basis').textContent).toContain('Plan: Budget 2026');
    expect(document.querySelector('.mr-ai-basis').textContent).toContain('mit Fonds-Kontext');

    document.getElementById('mr-plan-sel').value = '';
    mrChangePlan();
    analyzeReport.mockClear();
    await mrAnalyze();
    expect(analyzeReport.mock.calls[0][0].plan).toBeNull();
  });

  it('shows the server error when analysis fails', async () => {
    analyzeReport.mockRejectedValue(new Error('ANTHROPIC_API_KEY fehlt'));
    await mrAnalyze();
    expect(document.querySelector('.mr-ai-error').textContent).toContain('ANTHROPIC_API_KEY fehlt');
  });
});
