import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyGross, spreadPersonnel, spreadPersonnelDrivers } from '../src/lib/plan-personnel.js';

// Shorthand to build a base driver
const base = (overrides = {}) => ({
  employee_name:         'Test Employee',
  annual_gross_salary:   120000,
  payroll_burden_rate:   0,
  start_date:            null,
  end_date:              null,
  salary_increase_date:  null,
  annual_gross_salary_post_increase: null,
  annual_bonus:          0,
  bonus_month:           12,
  ...overrides,
});

// ── monthlyGross ──────────────────────────────────────────────────────

describe('monthlyGross — no increase', () => {
  it('returns annual/12 for a full month with no date bounds', () => {
    assert.equal(monthlyGross(2025, 1, null, null, 120000, null, null), 10000);
  });

  it('prorates start month (start Jan 16)', () => {
    const frac = 16 / 31; // 16 days remaining incl. the 16th
    const expected = Math.round((120000 / 12) * frac * 100) / 100;
    assert.equal(monthlyGross(2025, 1, new Date('2025-01-16'), null, 120000, null, null), expected);
  });

  it('prorates end month (end Nov 15)', () => {
    const frac = 15 / 30;
    const expected = Math.round((120000 / 12) * frac * 100) / 100;
    assert.equal(monthlyGross(2025, 11, null, new Date('2025-11-15'), 120000, null, null), expected);
  });

  it('returns 0 for months before employment start', () => {
    assert.equal(monthlyGross(2025, 1, new Date('2025-03-01'), null, 120000, null, null), 0);
  });

  it('returns 0 for months after employment end', () => {
    assert.equal(monthlyGross(2025, 12, null, new Date('2025-06-30'), 120000, null, null), 0);
  });
});

describe('monthlyGross — salary increase', () => {
  it('uses base salary for months entirely before increase', () => {
    const result = monthlyGross(2025, 3, null, null, 120000, new Date('2025-07-01'), 144000);
    assert.equal(result, 10000);
  });

  it('uses new salary for months entirely after increase', () => {
    const result = monthlyGross(2025, 9, null, null, 120000, new Date('2025-07-01'), 144000);
    assert.equal(result, 12000); // 144000/12
  });

  it('splits a month that straddles the increase date', () => {
    // Increase on July 16: 15 days at base, 16 days at new rate (July = 31 days)
    const basePart = (120000 / 12) * (15 / 31);
    const newPart  = (144000 / 12) * (16 / 31);
    const expected = Math.round((basePart + newPart) * 100) / 100;
    const result = monthlyGross(2025, 7, null, null, 120000, new Date('2025-07-16'), 144000);
    assert.equal(result, expected);
  });

  it('split month total is between base and new monthly rates', () => {
    const result = monthlyGross(2025, 7, null, null, 120000, new Date('2025-07-16'), 144000);
    assert.ok(result > 10000 && result < 12000);
  });
});

// ── spreadPersonnel — salary only ────────────────────────────────────

describe('spreadPersonnel — salary only, no burden', () => {
  it('generates 12 entries for a full-year employee', () => {
    const entries = spreadPersonnel(base(), 2025);
    assert.equal(entries.length, 12);
  });

  it('each month is €10,000 for €120k/year flat', () => {
    const entries = spreadPersonnel(base(), 2025);
    for (const e of entries) assert.equal(e.amount, 10000);
  });

  it('generates fewer entries for a mid-year hire', () => {
    const entries = spreadPersonnel(base({ start_date: new Date('2025-07-01') }), 2025);
    assert.equal(entries.length, 6);
    assert.equal(entries[0].month, 7);
  });

  it('prorates the first month when hire starts mid-month', () => {
    const entries = spreadPersonnel(base({ start_date: new Date('2025-07-16') }), 2025);
    const julyEntry = entries.find(e => e.month === 7);
    assert.ok(julyEntry.amount < 10000, 'July should be prorated');
    assert.ok(julyEntry.amount > 0);
  });

  it('prorates the last month when employee leaves mid-month', () => {
    const entries = spreadPersonnel(base({ end_date: new Date('2025-03-15') }), 2025);
    const marEntry = entries.find(e => e.month === 3);
    assert.ok(marEntry.amount < 10000, 'March should be prorated');
    assert.equal(entries.find(e => e.month === 4), undefined); // April gone
  });

  it('all years in entries match plan year', () => {
    const entries = spreadPersonnel(base(), 2025);
    for (const e of entries) assert.equal(e.year, 2025);
  });

  it('returns no entries when employee dates are entirely outside plan year', () => {
    const entries = spreadPersonnel(base({ start_date: new Date('2026-01-01') }), 2025);
    assert.equal(entries.length, 0);
  });
});

// ── spreadPersonnel — payroll burden ─────────────────────────────────

describe('spreadPersonnel — payroll burden', () => {
  it('applies burden rate on top of gross salary', () => {
    // €120k/year, 20% burden → €10,000 × 1.2 = €12,000/month
    const entries = spreadPersonnel(base({ payroll_burden_rate: 0.2 }), 2025);
    for (const e of entries) assert.equal(e.amount, 12000);
  });

  it('zero burden rate returns gross only', () => {
    const entries = spreadPersonnel(base({ payroll_burden_rate: 0 }), 2025);
    for (const e of entries) assert.equal(e.amount, 10000);
  });

  it('burden is applied to prorated partial month amount', () => {
    // Start July 1 → full July at 20% burden
    const entries = spreadPersonnel(base({ start_date: new Date('2025-07-01'), payroll_burden_rate: 0.2 }), 2025);
    const july = entries.find(e => e.month === 7);
    assert.equal(july.amount, 12000);
  });
});

// ── spreadPersonnel — salary increase ────────────────────────────────

describe('spreadPersonnel — salary increase', () => {
  it('months before increase use base salary', () => {
    const entries = spreadPersonnel(base({
      annual_gross_salary: 120000,
      salary_increase_date: new Date('2025-07-01'),
      annual_gross_salary_post_increase: 144000,
    }), 2025);
    for (const e of entries.filter(e => e.month < 7)) {
      assert.equal(e.amount, 10000);
    }
  });

  it('months after increase use new salary', () => {
    const entries = spreadPersonnel(base({
      annual_gross_salary: 120000,
      salary_increase_date: new Date('2025-07-01'),
      annual_gross_salary_post_increase: 144000,
    }), 2025);
    for (const e of entries.filter(e => e.month >= 7)) {
      assert.equal(e.amount, 12000);
    }
  });

  it('increase with burden applies burden to post-increase salary', () => {
    const entries = spreadPersonnel(base({
      annual_gross_salary: 120000,
      salary_increase_date: new Date('2025-07-01'),
      annual_gross_salary_post_increase: 144000,
      payroll_burden_rate: 0.2,
    }), 2025);
    // Aug = 12000 * 1.2 = 14400
    const aug = entries.find(e => e.month === 8);
    assert.equal(aug.amount, 14400);
  });
});

// ── spreadPersonnel — bonus ───────────────────────────────────────────

describe('spreadPersonnel — bonus', () => {
  it('places bonus in bonus_month (default December)', () => {
    const entries = spreadPersonnel(base({ annual_bonus: 20000 }), 2025);
    const dec = entries.find(e => e.month === 12);
    // Dec salary + bonus = 10000 + 20000 = 30000
    assert.equal(dec.amount, 30000);
    // All other months unchanged
    for (const e of entries.filter(e => e.month !== 12)) {
      assert.equal(e.amount, 10000);
    }
  });

  it('places bonus in configured bonus_month', () => {
    const entries = spreadPersonnel(base({ annual_bonus: 15000, bonus_month: 3 }), 2025);
    const mar = entries.find(e => e.month === 3);
    assert.equal(mar.amount, 25000); // 10000 + 15000
  });

  it('no bonus if employee leaves before bonus month', () => {
    const entries = spreadPersonnel(base({
      annual_bonus: 20000,
      bonus_month:  12,
      end_date:     new Date('2025-06-30'),
    }), 2025);
    const dec = entries.find(e => e.month === 12);
    assert.equal(dec, undefined);
  });

  it('bonus paid if employee is active for any part of bonus month', () => {
    // Employee starts Dec 15 — active in December, receives full bonus
    const entries = spreadPersonnel(base({
      annual_bonus: 20000,
      bonus_month:  12,
      start_date:   new Date('2025-12-15'),
    }), 2025);
    const dec = entries.find(e => e.month === 12);
    assert.ok(dec, 'December entry should exist');
    // Salary for 17 days + full bonus
    const salaryPart = Math.round((120000 / 12) * (17 / 31) * 100) / 100;
    assert.equal(dec.amount, Math.round((salaryPart + 20000) * 100) / 100);
  });

  it('burden is NOT applied to bonus', () => {
    const entries = spreadPersonnel(base({
      annual_bonus:       12000,
      payroll_burden_rate: 0.2,
    }), 2025);
    const dec = entries.find(e => e.month === 12);
    // December: salary 10000 × 1.2 + bonus 12000 (no burden on bonus) = 24000
    assert.equal(dec.amount, 24000);
  });
});

// ── spreadPersonnel — planned hire (is_filled=false) ─────────────────

describe('spreadPersonnel — planned hire', () => {
  it('generates the same amounts regardless of is_filled flag', () => {
    const filled   = spreadPersonnel(base({ is_filled: true,  start_date: new Date('2025-04-01') }), 2025);
    const unfilled = spreadPersonnel(base({ is_filled: false, start_date: new Date('2025-04-01') }), 2025);
    assert.deepEqual(filled, unfilled);
  });
});

// ── spreadPersonnelDrivers — multi-driver merge ───────────────────────

describe('spreadPersonnelDrivers', () => {
  it('sums two full-year employees', () => {
    const drivers = [
      base({ annual_gross_salary: 120000 }),
      base({ employee_name: 'Employee B', annual_gross_salary: 60000 }),
    ];
    const entries = spreadPersonnelDrivers(drivers, 2025);
    assert.equal(entries.length, 12);
    for (const e of entries) assert.equal(e.amount, 15000); // 10000 + 5000
  });

  it('handles partial-year hire alongside full-year employee', () => {
    const drivers = [
      base({ annual_gross_salary: 120000 }),
      base({ employee_name: 'New Hire', annual_gross_salary: 60000, start_date: new Date('2025-07-01') }),
    ];
    const entries = spreadPersonnelDrivers(drivers, 2025);
    const jan = entries.find(e => e.month === 1);
    const jul = entries.find(e => e.month === 7);
    assert.equal(jan.amount, 10000);   // only existing employee
    assert.equal(jul.amount, 15000);   // both employees
  });

  it('returns empty array for no drivers', () => {
    assert.equal(spreadPersonnelDrivers([], 2025).length, 0);
  });
});
