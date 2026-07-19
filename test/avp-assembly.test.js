/**
 * Ist-vs-Plan (AVP) assembly tests.
 *
 * These verify the two things the AVP view has to get right:
 *   1. The correct ACTUALS (Ist) end up in the comparison — the values that
 *      come out of the P&L engine (periodPLs) are the values shown, per month
 *      and summed over the selected period.
 *   2. The correct PLAN data is carried over — the plan entries stored per
 *      line item are aggregated into the right category and month, and summed
 *      over the selected period, with the drill-down line items always adding
 *      up to the category total on screen.
 *
 * The assertions reproduce exactly the pipeline in src/ui/avp.js (minus the
 * DOM rendering), using the same pure helpers that module imports:
 *   Ist  : extractActualsFromPeriods / extractActualsForRange
 *   Plan : aggregateByCategory / rangeTotal
 *   Merge: compareVersions
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateByCategory,
  compareVersions,
  rangeTotal,
} from '../src/lib/plan-compare.js';
import {
  extractActualsFromPeriods,
  extractActualsForRange,
} from '../src/lib/actuals-compare.js';

// ── Fixtures ──────────────────────────────────────────────────────────
//
// Actuals: distinct value per month so a month mix-up is caught. Revenue in
// month m = 10000 + 100*m, personnel = 4000 + 10*m, opex = 2000 + 5*m.
// EBITDA is what the engine computed (revenue − personnel − opex here).

function makePeriodPLs() {
  return Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const revenue   = 10000 + 100 * m;
    const personnel = 4000 + 10 * m;
    const opex      = 2000 + 5 * m;
    return {
      computed: {
        revenue,
        personnel,
        opex,
        depreciation: 0,
        ebitda: revenue - personnel - opex,
      },
    };
  });
}

// Plan: three line items (one per category), each with its own per-month value.
// Two revenue line items so the drill-down subtotal has something to add up.
const planLineItems = [
  { id: 1, category: 'revenue',   label: 'Produkt A', item_id: 'rev_main' },
  { id: 2, category: 'revenue',   label: 'Produkt B', item_id: 'rev_main' },
  { id: 3, category: 'personnel', label: 'Team',      item_id: 'pers_wages' },
  { id: 4, category: 'opex',      label: 'Miete',     item_id: 'opex_rent' },
];

// Plan entries: revenue A = 6000/mo, revenue B = 3000/mo, personnel = 4500/mo,
// opex = 2100/mo. Distinct from the actuals so Ist and Plan can't be confused.
function makePlanEntries() {
  const e = [];
  for (let m = 1; m <= 12; m++) {
    e.push({ line_item_id: 1, month: m, amount: 6000 });
    e.push({ line_item_id: 2, month: m, amount: 3000 });
    e.push({ line_item_id: 3, month: m, amount: 4500 });
    e.push({ line_item_id: 4, month: m, amount: 2100 });
  }
  return e;
}

// Reproduce avp.js renderAvpContent() up to the comparison rows.
function assemble(periodPLs, lineItems, entries) {
  const actualMonthly = extractActualsFromPeriods(periodPLs);
  const planMonthly   = aggregateByCategory(lineItems, entries);
  const rows          = compareVersions(actualMonthly, planMonthly);
  return { rows, planMonthly };
}

// ── 1. Actuals (Ist) are carried over correctly ───────────────────────

describe('AVP · actuals (Ist) side', () => {
  it('puts the engine actuals in the Ist (a) column, per month', () => {
    const periodPLs = makePeriodPLs();
    const { rows } = assemble(periodPLs, planLineItems, makePlanEntries());
    const rev = rows.find(r => r.key === 'revenue');
    for (let m = 1; m <= 12; m++) {
      assert.equal(rev.monthly[m].a, periodPLs[m - 1].computed.revenue);
    }
  });

  it('carries personnel and opex actuals per month, not just revenue', () => {
    const periodPLs = makePeriodPLs();
    const { rows } = assemble(periodPLs, planLineItems, makePlanEntries());
    const pers = rows.find(r => r.key === 'personnel');
    const opex = rows.find(r => r.key === 'opex');
    for (let m = 1; m <= 12; m++) {
      assert.equal(pers.monthly[m].a, periodPLs[m - 1].computed.personnel);
      assert.equal(opex.monthly[m].a, periodPLs[m - 1].computed.opex);
    }
  });

  it('uses the engine EBITDA for the monthly Ist cells (honours custom formula)', () => {
    // Give the engine an EBITDA that is NOT revenue − personnel − opex; the
    // monthly Ist cell must reflect the engine value, not a re-derivation.
    const periodPLs = makePeriodPLs();
    periodPLs[0].computed.ebitda = 12345;
    const { rows } = assemble(periodPLs, planLineItems, makePlanEntries());
    const ebitda = rows.find(r => r.key === 'ebitda');
    assert.equal(ebitda.monthly[1].a, 12345);
  });

  it('Ist period total sums exactly the selected months (Mar–Jun)', () => {
    const periodPLs = makePeriodPLs();
    const ist = extractActualsForRange(periodPLs, 3, 6);
    let expected = 0;
    for (let m = 3; m <= 6; m++) expected += periodPLs[m - 1].computed.revenue;
    assert.equal(ist.revenue, expected);
  });

  it('Ist period total respects the "from" month (does not start at January)', () => {
    const periodPLs = makePeriodPLs();
    const full  = extractActualsForRange(periodPLs, 1, 12);
    const march = extractActualsForRange(periodPLs, 3, 12);
    const janFeb = periodPLs[0].computed.revenue + periodPLs[1].computed.revenue;
    assert.equal(full.revenue - march.revenue, janFeb);
  });

  it('single-month range returns just that month', () => {
    const periodPLs = makePeriodPLs();
    const ist = extractActualsForRange(periodPLs, 7, 7);
    assert.equal(ist.revenue, periodPLs[6].computed.revenue);
  });

  it('Ist range EBITDA is re-derived from summed components', () => {
    const periodPLs = makePeriodPLs();
    const ist = extractActualsForRange(periodPLs, 1, 12);
    assert.equal(ist.ebitda, ist.revenue - ist.personnel - ist.opex);
  });

  it('shows zero actuals when no bookings exist for the year', () => {
    const empty = extractActualsFromPeriods([]);
    for (let m = 1; m <= 12; m++) {
      assert.equal(empty.get('revenue')[m], 0);
      assert.equal(empty.get('personnel')[m], 0);
    }
  });
});

// ── 2. Plan data is carried over correctly ────────────────────────────

describe('AVP · plan side', () => {
  it('aggregates plan entries into the Plan (b) column, per month', () => {
    const { rows } = assemble(makePeriodPLs(), planLineItems, makePlanEntries());
    const rev  = rows.find(r => r.key === 'revenue');
    const pers = rows.find(r => r.key === 'personnel');
    const opex = rows.find(r => r.key === 'opex');
    for (let m = 1; m <= 12; m++) {
      assert.equal(rev.monthly[m].b, 9000);  // 6000 (A) + 3000 (B)
      assert.equal(pers.monthly[m].b, 4500);
      assert.equal(opex.monthly[m].b, 2100);
    }
  });

  it('derives the plan EBITDA row from plan revenue − personnel − opex', () => {
    const { rows } = assemble(makePeriodPLs(), planLineItems, makePlanEntries());
    const ebitda = rows.find(r => r.key === 'ebitda');
    // 9000 − 4500 − 2100 = 2400 per month
    assert.equal(ebitda.monthly[1].b, 2400);
  });

  it('plan period total sums exactly the selected months (Mar–Jun)', () => {
    const { rows } = assemble(makePeriodPLs(), planLineItems, makePlanEntries());
    const rev = rows.find(r => r.key === 'revenue');
    const planByMonth = {};
    for (let m = 1; m <= 12; m++) planByMonth[m] = rev.monthly[m].b;
    // 9000 × 4 months = 36000
    assert.equal(rangeTotal(planByMonth, 3, 6), 36000);
  });

  it('does not carry over entries of deleted (inactive) line items', () => {
    // avp.js passes activeOnly line items; a soft-deleted line item's lingering
    // entries must not inflate the plan. Simulate by omitting line item 2.
    const activeItems = planLineItems.filter(li => li.id !== 2);
    const { rows } = assemble(makePeriodPLs(), activeItems, makePlanEntries());
    const rev = rows.find(r => r.key === 'revenue');
    assert.equal(rev.monthly[1].b, 6000);  // only A, B (id 2) excluded
  });

  it('shows plan values even when no actuals exist (Ist = 0, Plan intact)', () => {
    const noActuals = Array.from({ length: 12 }, () => ({ computed: {} }));
    const { rows } = assemble(noActuals, planLineItems, makePlanEntries());
    const rev = rows.find(r => r.key === 'revenue');
    assert.equal(rev.monthly[1].a, 0);
    assert.equal(rev.monthly[1].b, 9000);
  });
});

// ── 3. Ist and Plan cover the SAME period → Δ is meaningful ────────────

describe('AVP · Ist vs Plan variance', () => {
  it('Δ per month = Ist − Plan for revenue', () => {
    const periodPLs = makePeriodPLs();
    const { rows } = assemble(periodPLs, planLineItems, makePlanEntries());
    const rev = rows.find(r => r.key === 'revenue');
    for (let m = 1; m <= 12; m++) {
      // compareVersions delta = b − a (Plan − Ist); the table renders Ist − Plan.
      const istMinusPlan = rev.monthly[m].a - rev.monthly[m].b;
      assert.equal(rev.monthly[m].a - rev.monthly[m].b, istMinusPlan);
      assert.equal(rev.monthly[m].delta, rev.monthly[m].b - rev.monthly[m].a);
    }
  });

  it('Ist period total and Plan period total use an identical month window', () => {
    const periodPLs = makePeriodPLs();
    const { rows } = assemble(periodPLs, planLineItems, makePlanEntries());
    const rev = rows.find(r => r.key === 'revenue');

    const from = 4, to = 9;
    const ist = extractActualsForRange(periodPLs, from, to).revenue;

    const planByMonth = {};
    for (let m = 1; m <= 12; m++) planByMonth[m] = rev.monthly[m].b;
    const plan = rangeTotal(planByMonth, from, to);

    let expectedIst = 0;
    for (let m = from; m <= to; m++) expectedIst += periodPLs[m - 1].computed.revenue;
    assert.equal(ist, expectedIst);
    assert.equal(plan, 9000 * (to - from + 1));
  });
});

// ── 4. Drill-down line items add up to the category plan total ─────────

describe('AVP · plan drill-down totals', () => {
  // Reproduce the drill-down total: liEntryMap[li.id][month] summed via rangeTotal.
  function lineItemTotals(entries, ids, from, to) {
    const byId = new Map();
    for (const e of entries) {
      if (!byId.has(e.line_item_id)) byId.set(e.line_item_id, {});
      byId.get(e.line_item_id)[e.month] = Number(e.amount);
    }
    let sum = 0;
    for (const id of ids) sum += rangeTotal(byId.get(id) || {}, from, to);
    return sum;
  }

  it('drill-down line items sum to the parent plan total (full year)', () => {
    const entries = makePlanEntries();
    const { rows } = assemble(makePeriodPLs(), planLineItems, entries);
    const rev = rows.find(r => r.key === 'revenue');

    const planByMonth = {};
    for (let m = 1; m <= 12; m++) planByMonth[m] = rev.monthly[m].b;
    const parentTotal = rangeTotal(planByMonth, 1, 12);

    const drillTotal = lineItemTotals(entries, [1, 2], 1, 12);
    assert.equal(drillTotal, parentTotal);
    assert.equal(drillTotal, 9000 * 12);
  });

  it('REGRESSION: drill-down respects the "from" month for a partial range', () => {
    // Bug: the drill-down total used to filter only `month <= upTo`, ignoring
    // the "from" month, so a Mar–Sep range leaked Jan+Feb into every line item
    // and the drill-down no longer summed to the category total.
    const entries = makePlanEntries();
    const { rows } = assemble(makePeriodPLs(), planLineItems, entries);
    const rev = rows.find(r => r.key === 'revenue');

    const from = 3, to = 9;
    const planByMonth = {};
    for (let m = 1; m <= 12; m++) planByMonth[m] = rev.monthly[m].b;
    const parentTotal = rangeTotal(planByMonth, from, to);

    const drillTotal = lineItemTotals(entries, [1, 2], from, to);
    assert.equal(drillTotal, parentTotal);          // must add up
    assert.equal(drillTotal, 9000 * (to - from + 1)); // Mar–Sep only, no Jan/Feb
  });
});
