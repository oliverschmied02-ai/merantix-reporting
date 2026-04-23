import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateByCategory, annualTotals, compareVersions, COMPARE_ROWS } from '../src/lib/plan-compare.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const lineItems = [
  { id: 1, category: 'revenue'   },
  { id: 2, category: 'personnel' },
  { id: 3, category: 'opex'      },
];

// Simple 12-month entries: revenue = 10000/mo, personnel = 4000/mo, opex = 2000/mo
function makeEntries(revMo, persMo, opexMo) {
  const e = [];
  for (let m = 1; m <= 12; m++) {
    e.push({ line_item_id: 1, month: m, amount: revMo });
    e.push({ line_item_id: 2, month: m, amount: persMo });
    e.push({ line_item_id: 3, month: m, amount: opexMo });
  }
  return e;
}

// ── aggregateByCategory ───────────────────────────────────────────────

describe('aggregateByCategory', () => {
  it('aggregates revenue by month', () => {
    const m = aggregateByCategory(lineItems, makeEntries(10000, 4000, 2000));
    assert.equal(m.get('revenue')[1], 10000);
    assert.equal(m.get('revenue')[12], 10000);
  });

  it('aggregates personnel by month', () => {
    const m = aggregateByCategory(lineItems, makeEntries(10000, 4000, 2000));
    assert.equal(m.get('personnel')[6], 4000);
  });

  it('computes EBITDA = revenue - personnel - opex', () => {
    const m = aggregateByCategory(lineItems, makeEntries(10000, 4000, 2000));
    // 10000 - 4000 - 2000 = 4000
    assert.equal(m.get('ebitda')[1], 4000);
  });

  it('sums multiple line items in the same category', () => {
    const twoRevItems = [
      { id: 1, category: 'revenue' },
      { id: 2, category: 'revenue' },
    ];
    const entries = [
      { line_item_id: 1, month: 3, amount: 5000 },
      { line_item_id: 2, month: 3, amount: 3000 },
    ];
    const m = aggregateByCategory(twoRevItems, entries);
    assert.equal(m.get('revenue')[3], 8000);
  });

  it('returns zeros for months with no entries', () => {
    const m = aggregateByCategory(lineItems, []);
    assert.equal(m.get('revenue')[7], 0);
    assert.equal(m.get('ebitda')[7], 0);
  });

  it('ignores entries for unknown line_item_ids', () => {
    const entries = [{ line_item_id: 999, month: 1, amount: 99999 }];
    const m = aggregateByCategory(lineItems, entries);
    assert.equal(m.get('revenue')[1], 0);
  });

  it('EBITDA = revenue - personnel - opex (no allocation)', () => {
    const items = [
      { id: 1, category: 'revenue' },
      { id: 2, category: 'opex' },
    ];
    const entries = [
      { line_item_id: 1, month: 1, amount: 10000 },
      { line_item_id: 2, month: 1, amount: 2000 },
    ];
    const m = aggregateByCategory(items, entries);
    // EBITDA = 10000 - 0(pers) - 2000(opex) = 8000
    assert.equal(m.get('ebitda')[1], 8000);
  });
});

// ── annualTotals ──────────────────────────────────────────────────────

describe('annualTotals', () => {
  it('sums 12 months correctly', () => {
    const m = aggregateByCategory(lineItems, makeEntries(10000, 4000, 2000));
    const t = annualTotals(m);
    assert.equal(t.revenue,   120000);
    assert.equal(t.personnel, 48000);
    assert.equal(t.opex,      24000);
  });

  it('annual EBITDA equals 12 × monthly EBITDA for flat series', () => {
    const m = aggregateByCategory(lineItems, makeEntries(10000, 4000, 2000));
    const t = annualTotals(m);
    assert.equal(t.ebitda, 48000); // (10000 - 4000 - 2000) × 12
  });
});

// ── compareVersions ───────────────────────────────────────────────────

describe('compareVersions', () => {
  const mA = aggregateByCategory(lineItems, makeEntries(10000, 4000, 2000));
  const mB = aggregateByCategory(lineItems, makeEntries(12000, 5000, 2000));
  const rows = compareVersions(mA, mB);

  const rev  = rows.find(r => r.key === 'revenue');
  const pers = rows.find(r => r.key === 'personnel');
  const ebit = rows.find(r => r.key === 'ebitda');

  it('produces one row per COMPARE_ROWS entry', () => {
    assert.equal(rows.length, COMPARE_ROWS.length);
  });

  it('revenue annual: a=120000, b=144000', () => {
    assert.equal(rev.annual.a, 120000);
    assert.equal(rev.annual.b, 144000);
  });

  it('revenue delta = b - a = +24000', () => {
    assert.equal(rev.annual.delta, 24000);
  });

  it('revenue pct ≈ +20%', () => {
    assert.equal(rev.annual.pct, 20);
  });

  it('personnel delta = +12000 (5000-4000) × 12', () => {
    assert.equal(pers.annual.delta, 12000);
  });

  it('monthly delta is correct for revenue in month 3', () => {
    assert.equal(rev.monthly[3].a, 10000);
    assert.equal(rev.monthly[3].b, 12000);
    assert.equal(rev.monthly[3].delta, 2000);
  });

  it('EBITDA delta = revenue delta - personnel delta = 24000 - 12000 = 12000', () => {
    // A ebitda: (10k-4k-2k)×12 = 48k, B ebitda: (12k-5k-2k)×12 = 60k, delta = 12k
    assert.equal(ebit.annual.a, 48000);
    assert.equal(ebit.annual.b, 60000);
    assert.equal(ebit.annual.delta, 12000);
  });

  it('pct is null when base is 0', () => {
    const zeroA = aggregateByCategory(lineItems, makeEntries(0, 0, 0));
    const someB = aggregateByCategory(lineItems, makeEntries(10000, 0, 0));
    const r = compareVersions(zeroA, someB);
    assert.equal(r.find(x => x.key === 'revenue').annual.pct, null);
  });

  it('negative delta when B is lower than A', () => {
    const bigger = aggregateByCategory(lineItems, makeEntries(15000, 4000, 2000));
    const smaller = aggregateByCategory(lineItems, makeEntries(10000, 4000, 2000));
    const r = compareVersions(bigger, smaller);
    assert.equal(r.find(x => x.key === 'revenue').annual.delta, -60000);
  });

  it('all rows have monthly entries for all 12 months', () => {
    for (const row of rows) {
      assert.equal(Object.keys(row.monthly).length, 12);
    }
  });
});
