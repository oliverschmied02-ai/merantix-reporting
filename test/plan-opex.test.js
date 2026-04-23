import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spreadDriver, spreadDrivers } from '../src/lib/plan-revenue.js';

// Shorthand for a quarterly_flat driver
const quarterly = (overrides = {}) => ({
  driver_type: 'quarterly_flat',
  amount: 3000,
  start_date: null,
  end_date: null,
  spread_method: 'even',
  ...overrides,
});

// ── quarterly_flat — full year ────────────────────────────────────────

describe('quarterly_flat — full year', () => {
  it('produces exactly 4 entries for a full-year driver', () => {
    const entries = spreadDriver(quarterly(), 2025);
    assert.equal(entries.length, 4);
  });

  it('places amounts in Jan, Apr, Jul, Oct (quarter start months)', () => {
    const entries = spreadDriver(quarterly(), 2025);
    const months = entries.map(e => e.month);
    assert.deepEqual(months, [1, 4, 7, 10]);
  });

  it('each quarter receives the full driver amount (not split)', () => {
    const entries = spreadDriver(quarterly({ amount: 1500 }), 2025);
    for (const e of entries) assert.equal(e.amount, 1500);
  });

  it('all entries carry the correct plan year', () => {
    const entries = spreadDriver(quarterly(), 2025);
    for (const e of entries) assert.equal(e.year, 2025);
  });
});

// ── quarterly_flat — start_date mid-quarter ───────────────────────────

describe('quarterly_flat — start_date offsets first payment', () => {
  it('starts in Q2 when driver starts May 1 (Q2 active month is May)', () => {
    const entries = spreadDriver(quarterly({ start_date: new Date('2025-05-01') }), 2025);
    const months = entries.map(e => e.month);
    assert.deepEqual(months, [5, 7, 10]);
  });

  it('starts in Q3 when driver starts Aug 15 (Q3 active month is Aug)', () => {
    const entries = spreadDriver(quarterly({ start_date: new Date('2025-08-15') }), 2025);
    const months = entries.map(e => e.month);
    assert.deepEqual(months, [8, 10]);
  });

  it('starts in Q4 Oct 1 — only one payment', () => {
    const entries = spreadDriver(quarterly({ start_date: new Date('2025-10-01') }), 2025);
    const months = entries.map(e => e.month);
    assert.deepEqual(months, [10]);
  });

  it('starts in Q4 Nov — only one payment in Nov', () => {
    const entries = spreadDriver(quarterly({ start_date: new Date('2025-11-01') }), 2025);
    const months = entries.map(e => e.month);
    assert.deepEqual(months, [11]);
  });

  it('returns empty when start_date is after Dec 31 of plan year', () => {
    const entries = spreadDriver(quarterly({ start_date: new Date('2026-01-01') }), 2025);
    assert.equal(entries.length, 0);
  });
});

// ── quarterly_flat — end_date truncates payments ──────────────────────

describe('quarterly_flat — end_date truncates payments', () => {
  it('drops Q3 and Q4 payments when end_date is Jun 30', () => {
    const entries = spreadDriver(quarterly({ end_date: new Date('2025-06-30') }), 2025);
    const months = entries.map(e => e.month);
    assert.deepEqual(months, [1, 4]);
  });

  it('drops Q2, Q3, Q4 when end_date is Mar 31', () => {
    const entries = spreadDriver(quarterly({ end_date: new Date('2025-03-31') }), 2025);
    const months = entries.map(e => e.month);
    assert.deepEqual(months, [1]);
  });

  it('includes Q3 payment when end_date is Jul 1 (Jul is active)', () => {
    const entries = spreadDriver(quarterly({ end_date: new Date('2025-07-01') }), 2025);
    const months = entries.map(e => e.month);
    assert.deepEqual(months, [1, 4, 7]);
  });
});

// ── quarterly_flat — start + end combined ────────────────────────────

describe('quarterly_flat — start and end date combined', () => {
  it('May to Sep: Q2 payment in May, Q3 payment in Jul', () => {
    const entries = spreadDriver(quarterly({
      start_date: new Date('2025-05-01'),
      end_date:   new Date('2025-09-30'),
    }), 2025);
    const months = entries.map(e => e.month);
    assert.deepEqual(months, [5, 7]);
  });

  it('returns 0 entries when driver is entirely outside plan year', () => {
    const entries = spreadDriver(quarterly({
      start_date: new Date('2024-01-01'),
      end_date:   new Date('2024-12-31'),
    }), 2025);
    assert.equal(entries.length, 0);
  });
});

// ── mixed opex scenarios via spreadDrivers ────────────────────────────

describe('spreadDrivers — opex mix', () => {
  it('combines quarterly rent + monthly software subscription', () => {
    const rent = quarterly({ amount: 6000 });                  // 4 × 6000
    const saas = { driver_type: 'monthly_flat', amount: 500, start_date: null, end_date: null };
    const entries = spreadDrivers([rent, saas], 2025);

    // All 12 months should have some amount (SaaS fills every month)
    assert.equal(entries.length, 12);

    const jan = entries.find(e => e.month === 1);
    assert.equal(jan.amount, 6500); // 6000 rent + 500 SaaS

    const feb = entries.find(e => e.month === 2);
    assert.equal(feb.amount, 500);  // SaaS only
  });

  it('combines annual audit fee + one-off recruitment cost', () => {
    const audit    = { driver_type: 'annual_fee', amount: 24000, start_date: null, end_date: null };
    const recruits = { driver_type: 'one_off',    amount: 5000,  start_date: new Date('2025-03-01'), end_date: null };
    const entries  = spreadDrivers([audit, recruits], 2025);

    // March should carry audit share (2000) + one-off (5000) = 7000
    const mar = entries.find(e => e.month === 3);
    assert.equal(mar.amount, 7000);
  });

  it('returns empty array when no drivers', () => {
    assert.equal(spreadDrivers([], 2025).length, 0);
  });

  it('quarterly driver mid-year alongside full-year monthly_flat', () => {
    const quarterly2 = quarterly({ amount: 3000, start_date: new Date('2025-07-01') });
    const flat = { driver_type: 'monthly_flat', amount: 200, start_date: null, end_date: null };
    const entries = spreadDrivers([quarterly2, flat], 2025);

    const jan = entries.find(e => e.month === 1);
    assert.equal(jan.amount, 200);  // flat only, quarterly not active yet

    const jul = entries.find(e => e.month === 7);
    assert.equal(jul.amount, 3200); // 3000 quarterly + 200 flat
  });
});

// ── management_fee ────────────────────────────────────────────────────

describe('management_fee — full year', () => {
  const mgmt = (overrides = {}) => ({
    driver_type: 'management_fee',
    amount: 2000000,   // 100m × 2% pre-computed by server
    start_date: null,
    end_date: null,
    spread_method: 'even',
    ...overrides,
  });

  it('produces 12 entries for a full-year driver', () => {
    const entries = spreadDriver(mgmt(), 2025);
    assert.equal(entries.length, 12);
  });

  it('annual total equals the supplied amount', () => {
    const entries = spreadDriver(mgmt(), 2025);
    const total = entries.reduce((s, e) => s + e.amount, 0);
    assert.ok(Math.abs(total - 2000000) < 0.01);
  });

  it('distributes evenly — each month ~166666.67', () => {
    const entries = spreadDriver(mgmt(), 2025);
    for (const e of entries) {
      assert.ok(Math.abs(e.amount - 2000000 / 12) < 1);
    }
  });

  it('respects start_date — partial year sums correctly', () => {
    // Start July 1 → 6 active months
    const entries = spreadDriver(mgmt({ start_date: '2025-07-01' }), 2025);
    assert.equal(entries.length, 6);
    const total = entries.reduce((s, e) => s + e.amount, 0);
    assert.ok(Math.abs(total - 2000000) < 0.01);
  });

  it('assigns remainder to last month to avoid rounding drift', () => {
    // Use an amount that doesn't divide evenly
    const entries = spreadDriver(mgmt({ amount: 1000001 }), 2025);
    const total = entries.reduce((s, e) => s + e.amount, 0);
    assert.ok(Math.abs(total - 1000001) < 0.01);
  });
});
