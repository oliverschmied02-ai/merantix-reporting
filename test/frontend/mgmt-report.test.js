import { describe, it, expect, beforeEach, vi } from 'vitest';

// Settings API: no saved comments yet; saves are recorded.
const saved = {};
vi.mock('../../src/lib/db.js', () => ({
  getSetting: vi.fn(async key => saved[key] ?? null),
  saveSetting: vi.fn(async (key, value) => { saved[key] = value; }),
  loadTransactionsForYear: vi.fn(async () => []),
}));

import { APP, resetAPP } from '../../src/state.js';
import { rebuildAcctMap } from '../../src/lib/resolve.js';
import { ensureTaxSection } from '../../src/lib/storage.js';
import { DEFAULT_PL_DEF } from '../../src/data/default-pl.js';
import { deepClone } from '../../src/lib/utils.js';
import { openReportScreen, mrCommentInput } from '../../src/ui/mgmt-report.js';

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
    const def = deepClone(DEFAULT_PL_DEF);
    expect(ensureTaxSection(def)).toBe(false);
  });
});

describe('Management report', () => {
  beforeEach(() => {
    resetAPP();
    APP.years = [2026];
    APP.loadedYears = new Set([2026]);
    APP.allTransactions = [
      txn(440000, 0, 100000, 3),   // revenue 100k in Mar
      txn(630300, 30000, 0, 3),    // opex 30k in Mar
      txn(760000, 20000, 0, 3),    // Körperschaftsteuer 20k in Mar
      txn(440000, 0, 50000, 1),    // revenue 50k in Jan (YTD only)
    ];
    rebuildAcctMap();
    document.body.innerHTML = `
      <div id="toast"></div>
      <select id="mr-year-sel"></select>
      <select id="mr-period-sel"></select>
      <span id="mr-save-status"></span>
      <div id="mr-content"></div>`;
  });

  it('shows period + YTD values, taxes and net income below EBT', async () => {
    await openReportScreen();
    const rows = [...document.querySelectorAll('#mr-content tbody tr')];
    const row = label => rows.find(tr => tr.querySelector('.mr-pos')?.textContent === label);

    const ebt = row('EBT (Ergebnis vor Steuern)');
    const tax = row('Steuern vom Einkommen und Ertrag');
    const net = row('Jahresergebnis (nach Steuern)');
    expect(rows.indexOf(tax)).toBe(rows.indexOf(ebt) + 1); // taxes directly below EBT
    expect(net).toBeTruthy();

    // Mar: 100k − 30k = 70k EBT; − 20k tax = 50k. YTD adds Jan revenue 50k.
    const nums = tr => [...tr.querySelectorAll('.mr-num')].map(td => td.textContent.trim());
    expect(nums(ebt)).toEqual(['70.000', '120.000']);
    expect(nums(tax)).toEqual(['−20.000', '−20.000']);
    expect(nums(net)).toEqual(['50.000', '100.000']);

    // Every row carries a comment field.
    expect(rows.every(tr => tr.querySelector('textarea.mr-comment-input'))).toBe(true);
  });

  it('auto-saves comments per year + period', async () => {
    vi.useFakeTimers();
    await openReportScreen();
    const ta = document.querySelector('#mr-content textarea.mr-comment-input');
    ta.value = 'Umsatz über Plan wegen Fund II Closing';
    mrCommentInput('revenue', ta);
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    await flush();
    expect(saved['mgmt_report_v1_2026_M3']?.comments?.revenue).toBe('Umsatz über Plan wegen Fund II Closing');
  });
});
