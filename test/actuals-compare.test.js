import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractActualsFromPeriods, extractActualsYTD } from '../src/lib/actuals-compare.js';

// Build a fake periodPLs array
function makePeriods(overrides = {}) {
  return Array.from({ length: 12 }, (_, i) => ({
    computed: {
      revenue:   overrides.revenue?.[i]   ?? 10000,
      personnel: overrides.personnel?.[i] ?? 4000,
      opex:      overrides.opex?.[i]      ?? 2000,
      ebitda:    overrides.ebitda?.[i]    ?? 4000,
      ...overrides.extra,
    },
  }));
}

// ── extractActualsFromPeriods ─────────────────────────────────────────

describe('extractActualsFromPeriods', () => {
  it('returns a Map with entries for every COMPARE_ROWS key', () => {
    const m = extractActualsFromPeriods(makePeriods());
    assert.ok(m.has('revenue'));
    assert.ok(m.has('personnel'));
    assert.ok(m.has('opex'));
    assert.ok(m.has('ebitda'));
    assert.ok(m.has('allocation'));
    assert.ok(m.has('other'));
  });

  it('maps revenue correctly for month 1', () => {
    const m = extractActualsFromPeriods(makePeriods({ revenue: Array(12).fill(12000) }));
    assert.equal(m.get('revenue')[1], 12000);
  });

  it('maps revenue for all 12 months', () => {
    const revByMonth = Array.from({ length: 12 }, (_, i) => (i + 1) * 1000);
    const m = extractActualsFromPeriods(makePeriods({ revenue: revByMonth }));
    for (let mo = 1; mo <= 12; mo++) {
      assert.equal(m.get('revenue')[mo], mo * 1000);
    }
  });

  it('uses pre-computed ebitda from periodPLs (not re-derived)', () => {
    // Set ebitda explicitly different from revenue-personnel-opex to verify
    const m = extractActualsFromPeriods(makePeriods({ ebitda: Array(12).fill(9999) }));
    assert.equal(m.get('ebitda')[1], 9999);
  });

  it('allocation defaults to 0 for all months', () => {
    const m = extractActualsFromPeriods(makePeriods());
    for (let mo = 1; mo <= 12; mo++) assert.equal(m.get('allocation')[mo], 0);
  });

  it('other defaults to 0 for all months', () => {
    const m = extractActualsFromPeriods(makePeriods());
    for (let mo = 1; mo <= 12; mo++) assert.equal(m.get('other')[mo], 0);
  });

  it('rounds to 2 decimal places', () => {
    const m = extractActualsFromPeriods(makePeriods({ revenue: Array(12).fill(10000 / 3) }));
    const val = m.get('revenue')[1];
    assert.ok(Number.isFinite(val));
    assert.ok(String(val).split('.')[1]?.length <= 2 || !String(val).includes('.'));
  });

  it('handles partial periodPLs (fewer than 12 months)', () => {
    const partial = [
      { computed: { revenue: 5000, personnel: 2000, opex: 1000, ebitda: 2000 } },
      { computed: { revenue: 6000, personnel: 2200, opex: 1100, ebitda: 2700 } },
    ];
    const m = extractActualsFromPeriods(partial);
    assert.equal(m.get('revenue')[1], 5000);
    assert.equal(m.get('revenue')[2], 6000);
    assert.equal(m.get('revenue')[3], 0);  // no data = 0
    assert.equal(m.get('revenue')[12], 0);
  });

  it('handles empty periodPLs gracefully', () => {
    const m = extractActualsFromPeriods([]);
    for (let mo = 1; mo <= 12; mo++) assert.equal(m.get('revenue')[mo], 0);
  });

  it('handles missing computed keys gracefully', () => {
    const periods = [{ computed: {} }];  // no revenue, personnel etc.
    const m = extractActualsFromPeriods(periods);
    assert.equal(m.get('revenue')[1], 0);
    assert.equal(m.get('ebitda')[1], 0);
  });

  it('maps personnel correctly', () => {
    const m = extractActualsFromPeriods(makePeriods({ personnel: Array(12).fill(7500) }));
    for (let mo = 1; mo <= 12; mo++) assert.equal(m.get('personnel')[mo], 7500);
  });

  it('maps opex correctly', () => {
    const m = extractActualsFromPeriods(makePeriods({ opex: Array(12).fill(3200) }));
    for (let mo = 1; mo <= 12; mo++) assert.equal(m.get('opex')[mo], 3200);
  });
});

// ── extractActualsYTD ─────────────────────────────────────────────────

describe('extractActualsYTD', () => {
  it('sums revenue up to the specified month', () => {
    const ytd = extractActualsYTD(makePeriods(), 6);
    assert.equal(ytd.revenue, 60000);   // 6 × 10000
  });

  it('stops at upToMonth', () => {
    const ytd = extractActualsYTD(makePeriods(), 3);
    assert.equal(ytd.revenue, 30000);
  });

  it('full year sums correctly', () => {
    const ytd = extractActualsYTD(makePeriods(), 12);
    assert.equal(ytd.revenue,   120000);
    assert.equal(ytd.personnel, 48000);
    assert.equal(ytd.opex,      24000);
  });

  it('YTD EBITDA is re-derived from components (revenue - personnel - opex)', () => {
    // 10000 - 4000 - 2000 = 4000/mo × 6 months = 24000
    const ytd = extractActualsYTD(makePeriods(), 6);
    assert.equal(ytd.ebitda, 24000);
  });

  it('returns zero YTD for empty periodPLs', () => {
    const ytd = extractActualsYTD([], 6);
    assert.equal(ytd.revenue, 0);
    assert.equal(ytd.ebitda, 0);
  });
});
