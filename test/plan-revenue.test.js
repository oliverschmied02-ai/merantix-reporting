import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysInMonth,
  monthFraction,
  activeMonthWeight,
  spreadDriver,
  spreadDrivers,
} from '../src/lib/plan-revenue.js';

// ── daysInMonth ───────────────────────────────────────────────────────

describe('daysInMonth', () => {
  it('returns 31 for January', () => assert.equal(daysInMonth(2025, 1), 31));
  it('returns 28 for Feb in non-leap year', () => assert.equal(daysInMonth(2025, 2), 28));
  it('returns 29 for Feb in leap year', () => assert.equal(daysInMonth(2024, 2), 29));
  it('returns 30 for April', () => assert.equal(daysInMonth(2025, 4), 30));
  it('returns 31 for December', () => assert.equal(daysInMonth(2025, 12), 31));
});

// ── monthFraction ─────────────────────────────────────────────────────

describe('monthFraction', () => {
  it('returns 1.0 for null bounds (full month)', () => {
    assert.equal(monthFraction(2025, 1, null, null), 1.0);
  });

  it('returns 1.0 when range covers full month', () => {
    assert.equal(
      monthFraction(2025, 1, new Date('2025-01-01'), new Date('2025-01-31')),
      1.0
    );
  });

  it('returns 0.5 for first 15 days of a 30-day month (April)', () => {
    const frac = monthFraction(2025, 4, new Date('2025-04-01'), new Date('2025-04-15'));
    assert.equal(frac, 15 / 30);
  });

  it('returns 0.0 for a range entirely before the month', () => {
    assert.equal(
      monthFraction(2025, 3, new Date('2025-01-01'), new Date('2025-02-28')),
      0.0
    );
  });

  it('returns 0.0 for a range entirely after the month', () => {
    assert.equal(
      monthFraction(2025, 1, new Date('2025-02-01'), null),
      0.0
    );
  });

  it('handles start mid-month correctly', () => {
    // Jan 16 to end of January = 16 days / 31 days
    const frac = monthFraction(2025, 1, new Date('2025-01-16'), null);
    assert.equal(frac, 16 / 31);
  });

  it('handles end mid-month correctly', () => {
    // Jan 1 to Jan 10 = 10 days / 31 days
    const frac = monthFraction(2025, 1, null, new Date('2025-01-10'));
    assert.equal(frac, 10 / 31);
  });
});

// ── activeMonthWeight ─────────────────────────────────────────────────

describe('activeMonthWeight', () => {
  it('returns 12 for full year (null bounds)', () => {
    assert.equal(activeMonthWeight(2025, null, null), 12);
  });

  it('returns 6 for July–December', () => {
    assert.equal(
      activeMonthWeight(2025, new Date('2025-07-01'), new Date('2025-12-31')),
      6
    );
  });

  it('returns 0 for range outside the year', () => {
    assert.equal(
      activeMonthWeight(2025, new Date('2024-01-01'), new Date('2024-12-31')),
      0
    );
  });

  it('handles partial first month', () => {
    // July 16 – Dec 31: 5 full months + 16/31 of July
    const w = activeMonthWeight(2025, new Date('2025-07-16'), new Date('2025-12-31'));
    assert.ok(w > 5 && w < 6, `expected between 5 and 6, got ${w}`);
  });
});

// ── spreadDriver: annual_fee ──────────────────────────────────────────

describe('spreadDriver annual_fee', () => {
  const base = { driver_type: 'annual_fee', spread_method: 'even', start_date: null, end_date: null };

  it('spreads €120,000 evenly across 12 months → €10,000 each', () => {
    const entries = spreadDriver({ ...base, amount: 120000 }, 2025);
    assert.equal(entries.length, 12);
    for (const e of entries) assert.equal(e.amount, 10000);
  });

  it('total always equals original amount (no rounding leak)', () => {
    // Use an amount that doesn't divide evenly by 12
    const entries = spreadDriver({ ...base, amount: 100000 }, 2025);
    const total = entries.reduce((s, e) => s + e.amount, 0);
    assert.equal(total, 100000);
  });

  it('assigns remainder to last active month', () => {
    const entries = spreadDriver({ ...base, amount: 100000 }, 2025);
    // €100,000 / 12 = €8,333.33 per month. Last month absorbs remainder.
    const last = entries[entries.length - 1];
    const rest = entries.slice(0, -1).reduce((s, e) => s + e.amount, 0);
    assert.equal(Math.round((last.amount + rest) * 100) / 100, 100000);
  });

  it('spreads only over active months when start_date is mid-year', () => {
    const entries = spreadDriver(
      { ...base, amount: 60000, start_date: new Date('2025-07-01') },
      2025
    );
    assert.equal(entries.length, 6);
    assert.equal(entries[0].month, 7);
    const total = entries.reduce((s, e) => s + e.amount, 0);
    assert.equal(total, 60000);
  });

  it('handles partial start month proportionally', () => {
    // Starts July 16 — July gets (16/31) share, Aug–Dec get full shares
    const entries = spreadDriver(
      { ...base, amount: 100000, start_date: new Date('2025-07-16') },
      2025
    );
    const julyEntry = entries.find(e => e.month === 7);
    const augEntry  = entries.find(e => e.month === 8);
    assert.ok(julyEntry, 'July entry should exist');
    assert.ok(julyEntry.amount < augEntry.amount, 'July should be less than August');
    const total = entries.reduce((s, e) => s + e.amount, 0);
    assert.equal(total, 100000);
  });

  it('returns empty array when driver is entirely outside the plan year', () => {
    const entries = spreadDriver(
      { ...base, amount: 100000, start_date: new Date('2026-01-01') },
      2025
    );
    assert.equal(entries.length, 0);
  });

  it('all entries have the correct year', () => {
    const entries = spreadDriver({ ...base, amount: 120000 }, 2025);
    for (const e of entries) assert.equal(e.year, 2025);
  });
});

// ── spreadDriver: monthly_flat ────────────────────────────────────────

describe('spreadDriver monthly_flat', () => {
  const base = { driver_type: 'monthly_flat', spread_method: 'even', start_date: null, end_date: null };

  it('places the same amount in every month', () => {
    const entries = spreadDriver({ ...base, amount: 15000 }, 2025);
    assert.equal(entries.length, 12);
    for (const e of entries) assert.equal(e.amount, 15000);
  });

  it('prorates a partial first month', () => {
    const entries = spreadDriver(
      { ...base, amount: 10000, start_date: new Date('2025-01-16') },
      2025
    );
    const jan = entries.find(e => e.month === 1);
    const feb = entries.find(e => e.month === 2);
    assert.ok(jan.amount < 10000, 'January should be prorated');
    assert.equal(feb.amount, 10000);
    assert.equal(Math.round(jan.amount * 100) / 100, Math.round(10000 * (16 / 31) * 100) / 100);
  });

  it('only covers months within date range', () => {
    const entries = spreadDriver(
      { ...base, amount: 5000, start_date: new Date('2025-03-01'), end_date: new Date('2025-05-31') },
      2025
    );
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map(e => e.month), [3, 4, 5]);
  });
});

// ── spreadDriver: one_off ─────────────────────────────────────────────

describe('spreadDriver one_off', () => {
  const base = { driver_type: 'one_off', spread_method: 'even', end_date: null };

  it('places full amount in start month', () => {
    const entries = spreadDriver(
      { ...base, amount: 50000, start_date: new Date('2025-06-15') },
      2025
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].month, 6);
    assert.equal(entries[0].amount, 50000);
  });

  it('defaults to January when start_date is null', () => {
    const entries = spreadDriver({ ...base, amount: 25000, start_date: null }, 2025);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].month, 1);
  });

  it('returns empty when start_date is outside the plan year', () => {
    const entries = spreadDriver(
      { ...base, amount: 10000, start_date: new Date('2026-03-01') },
      2025
    );
    assert.equal(entries.length, 0);
  });
});

// ── spreadDrivers (multi-driver merge) ───────────────────────────────

describe('spreadDrivers', () => {
  it('sums amounts when two drivers cover the same month', () => {
    const drivers = [
      { driver_type: 'monthly_flat', amount: 10000, start_date: null, end_date: null, spread_method: 'even' },
      { driver_type: 'monthly_flat', amount: 5000,  start_date: null, end_date: null, spread_method: 'even' },
    ];
    const entries = spreadDrivers(drivers, 2025);
    assert.equal(entries.length, 12);
    for (const e of entries) assert.equal(e.amount, 15000);
  });

  it('merges non-overlapping drivers correctly', () => {
    const drivers = [
      { driver_type: 'one_off', amount: 100000, start_date: new Date('2025-01-01'), end_date: null, spread_method: 'even' },
      { driver_type: 'one_off', amount: 200000, start_date: new Date('2025-06-01'), end_date: null, spread_method: 'even' },
    ];
    const entries = spreadDrivers(drivers, 2025);
    assert.equal(entries.length, 2);
    assert.equal(entries.find(e => e.month === 1).amount, 100000);
    assert.equal(entries.find(e => e.month === 6).amount, 200000);
  });

  it('returns empty array for empty driver list', () => {
    assert.equal(spreadDrivers([], 2025).length, 0);
  });
});
