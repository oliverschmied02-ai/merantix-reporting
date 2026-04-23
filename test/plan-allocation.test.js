import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allocate } from '../src/lib/plan-allocation.js';

// Helpers
const months = (amounts) =>
  amounts.map((amount, i) => ({ month: i + 1, year: 2025, amount }));

const twoTargets = [
  { id: 1, label: 'Fund I',      pct_share: 60 },
  { id: 2, label: 'Merantix AG', pct_share: 40 },
];

const threeTargets = [
  { id: 1, label: 'Entity A', pct_share: 50 },
  { id: 2, label: 'Entity B', pct_share: 30 },
  { id: 3, label: 'Entity C', pct_share: 20 },
];

// ── fixed_pct ─────────────────────────────────────────────────────────

describe('allocate — fixed_pct', () => {
  it('splits a single month 60/40', () => {
    const result = allocate(months([10000]), twoTargets, 'fixed_pct');
    assert.equal(result.length, 2);
    const fund = result.find(r => r.target_id === 1);
    const mxag = result.find(r => r.target_id === 2);
    assert.equal(fund.allocated_amount, 6000);
    assert.equal(mxag.allocated_amount, 4000);
  });

  it('preserves source_amount on each result row', () => {
    const result = allocate(months([10000]), twoTargets, 'fixed_pct');
    for (const r of result) assert.equal(r.source_amount, 10000);
  });

  it('produces n_targets × n_months rows', () => {
    const result = allocate(months([1000, 2000, 3000]), twoTargets, 'fixed_pct');
    assert.equal(result.length, 6); // 2 targets × 3 months
  });

  it('carries correct month on each row', () => {
    const result = allocate(months([1000, 2000]), twoTargets, 'fixed_pct');
    const months1 = result.filter(r => r.target_id === 1).map(r => r.month);
    assert.deepEqual(months1, [1, 2]);
  });

  it('three targets summing to 100%', () => {
    const result = allocate(months([12000]), threeTargets, 'fixed_pct');
    const total = result.reduce((s, r) => s + r.allocated_amount, 0);
    assert.equal(total, 12000);
  });

  it('partial allocation: targets sum to 70%, remainder stays at source', () => {
    const partialTargets = [
      { id: 1, label: 'Fund I', pct_share: 70 },
    ];
    const result = allocate(months([10000]), partialTargets, 'fixed_pct');
    assert.equal(result[0].allocated_amount, 7000);
    // Source retains 3000 — engine doesn't create a "remainder" row, caller handles it
  });

  it('throws when pct_share sum exceeds 100', () => {
    const badTargets = [
      { id: 1, label: 'A', pct_share: 60 },
      { id: 2, label: 'B', pct_share: 60 },
    ];
    assert.throws(
      () => allocate(months([10000]), badTargets, 'fixed_pct'),
      /≤ 100/
    );
  });

  it('rounds to 2 decimal places', () => {
    const targets = [{ id: 1, label: 'A', pct_share: 33.33 }];
    const result = allocate(months([1000]), targets, 'fixed_pct');
    assert.equal(result[0].allocated_amount, 333.3);
  });

  it('returns empty array when no source entries', () => {
    const result = allocate([], twoTargets, 'fixed_pct');
    assert.equal(result.length, 0);
  });

  it('returns empty array when no targets', () => {
    const result = allocate(months([1000]), [], 'fixed_pct');
    assert.equal(result.length, 0);
  });
});

// ── equal_split ───────────────────────────────────────────────────────

describe('allocate — equal_split', () => {
  it('splits evenly among two targets', () => {
    const targets = [{ id: 1, label: 'A' }, { id: 2, label: 'B' }];
    const result = allocate(months([10000]), targets, 'equal_split');
    assert.equal(result.find(r => r.target_id === 1).allocated_amount, 5000);
    assert.equal(result.find(r => r.target_id === 2).allocated_amount, 5000);
  });

  it('splits evenly among three targets', () => {
    const targets = [{ id: 1, label: 'A' }, { id: 2, label: 'B' }, { id: 3, label: 'C' }];
    const result = allocate(months([9000]), targets, 'equal_split');
    for (const r of result) assert.equal(r.allocated_amount, 3000);
  });

  it('penny remainder goes to first target', () => {
    const targets = [{ id: 1, label: 'A' }, { id: 2, label: 'B' }, { id: 3, label: 'C' }];
    // 10 / 3 = 3.33… → base 3.33, remainder 0.01 to first
    const result = allocate(months([10]), targets, 'equal_split');
    const a1 = result.find(r => r.target_id === 1).allocated_amount;
    const a2 = result.find(r => r.target_id === 2).allocated_amount;
    const a3 = result.find(r => r.target_id === 3).allocated_amount;
    assert.equal(a1 + a2 + a3, 10); // total preserves source
    assert.ok(a1 >= a2 && a1 >= a3, 'first target gets remainder');
  });

  it('produces correct total across all targets for every month', () => {
    const targets = [{ id: 1, label: 'A' }, { id: 2, label: 'B' }];
    const src = months([1000, 2000, 3000]);
    const result = allocate(src, targets, 'equal_split');
    for (const m of [1, 2, 3]) {
      const monthTotal = result
        .filter(r => r.month === m)
        .reduce((s, r) => s + r.allocated_amount, 0);
      const srcAmount = src.find(e => e.month === m).amount;
      assert.equal(monthTotal, srcAmount);
    }
  });

  it('pct_share is ignored for equal_split', () => {
    const withPct    = [{ id: 1, label: 'A', pct_share: 99 }, { id: 2, label: 'B', pct_share: 1 }];
    const withoutPct = [{ id: 1, label: 'A' },                { id: 2, label: 'B' }];
    const r1 = allocate(months([1000]), withPct,    'equal_split');
    const r2 = allocate(months([1000]), withoutPct, 'equal_split');
    assert.equal(r1.find(r => r.target_id === 1).allocated_amount,
                 r2.find(r => r.target_id === 1).allocated_amount);
  });
});

// ── manual ────────────────────────────────────────────────────────────

describe('allocate — manual', () => {
  it('returns manually specified amounts', () => {
    const targets = [
      { id: 1, label: 'Fund I',  manual_amounts: { 1: 4000, 2: 4500 } },
      { id: 2, label: 'Fund II', manual_amounts: { 1: 3000, 2: 2500 } },
    ];
    const result = allocate(months([7000, 7000]), targets, 'manual');
    assert.equal(result.find(r => r.target_id === 1 && r.month === 1).allocated_amount, 4000);
    assert.equal(result.find(r => r.target_id === 2 && r.month === 2).allocated_amount, 2500);
  });

  it('preserves source_amount on manual rows', () => {
    const targets = [{ id: 1, label: 'A', manual_amounts: { 1: 500 } }];
    const result = allocate(months([1000]), targets, 'manual');
    assert.equal(result[0].source_amount, 1000);
  });

  it('skips months with no manual_amounts entry', () => {
    const targets = [{ id: 1, label: 'A', manual_amounts: { 3: 500 } }];
    const result = allocate(months([1000, 1000, 1000]), targets, 'manual');
    // Only month 3 has a manual entry
    assert.equal(result.length, 1);
    assert.equal(result[0].month, 3);
  });

  it('skips months where source has no entry', () => {
    const targets = [{ id: 1, label: 'A', manual_amounts: { 6: 500 } }];
    // Source only has 3 months (Jan–Mar)
    const result = allocate(months([1000, 1000, 1000]), targets, 'manual');
    assert.equal(result.length, 0);
  });

  it('returns empty when targets have no manual_amounts', () => {
    const targets = [{ id: 1, label: 'A' }];
    const result = allocate(months([1000]), targets, 'manual');
    assert.equal(result.length, 0);
  });
});

// ── unknown method ────────────────────────────────────────────────────

describe('allocate — invalid method', () => {
  it('throws on unknown method', () => {
    assert.throws(
      () => allocate(months([1000]), twoTargets, 'headcount'),
      /Unknown allocation method/
    );
  });
});
