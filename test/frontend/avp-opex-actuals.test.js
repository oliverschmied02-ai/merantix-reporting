import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the DB layer so the AVP view has a plan version + one OpEx line item.
vi.mock('../../src/lib/db.js', () => ({
  getPlanVersions:  vi.fn(async () => [{ id: 1, year: 2026, name: 'Budget', type: 'budget' }]),
  getPlanLineItems: vi.fn(async () => [
    { id: 10, category: 'opex', item_id: 'opex_ext', label: 'Fundraising Consulting', entity: null },
  ]),
  getPlanEntries:   vi.fn(async () => [
    { line_item_id: 10, month: 6, amount: 40000 }, // plan Fremdleistungen = 40k in Jun
  ]),
}));

import { APP, resetAPP } from '../../src/state.js';
import { rebuildAcctMap } from '../../src/lib/resolve.js';
import { openAvpScreen, avpToggleDrilldown } from '../../src/ui/avp.js';

const flush = () => new Promise(r => setTimeout(r, 0));

function setupDOM() {
  document.body.innerHTML = `
    <select id="year-sel"><option value="2026" selected>2026</option></select>
    <div id="toast-container"></div>
    <div id="avp-screen">
      <select id="avp-year-sel"></select>
      <select id="avp-version-sel"></select>
      <select id="avp-month-from-sel"></select>
      <select id="avp-month-to-sel"></select>
      <div id="avp-content"></div>
    </div>`;
}

// One real OpEx booking: account 630300 → sub "Fremdleistungen" (opex_ext), Jun.
const TXN = {
  ktonr: 630300, gktonr: 70000, soll: 70000, haben: 0,
  datum: new Date('2026-06-15'), text: 'Beratung', beleg: 'RE-1',
  wjMonth: 6, wjYear: 2026,
};

describe('AVP OpEx drill-down actuals', () => {
  beforeEach(() => {
    resetAPP();
    APP.years = [2026];
    APP.allTransactions = [TXN];
    rebuildAcctMap();
    setupDOM();
  });

  it('shows Ist + Δ at the sub-category (Fremdleistungen) level', async () => {
    await openAvpScreen();
    await flush();                 // renderAvpContent() runs async after loads
    avpToggleDrilldown('opex');    // expand the OpEx category
    await flush();

    const rows = [...document.querySelectorAll('#avp-content tr')];
    const frem = rows.find(tr => tr.textContent.includes('Fremdleistungen'));
    expect(frem, 'Fremdleistungen group row rendered').toBeTruthy();

    const text = frem.textContent;
    // Ist 70k and Plan 40k now both appear on the group row (in T€: 70,0 / 40,0),
    // and the delta +30,0 — previously the group was plan-only (Ist/Δ blank).
    expect(text).toContain('70,0');
    expect(text).toContain('40,0');
    expect(text).toContain('+30,0');
  });
});
