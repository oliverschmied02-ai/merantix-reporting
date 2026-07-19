/**
 * Monthly-sum integrity for personnel planning.
 *
 * These tests guard the invariant the Planning tab relies on: the per-month
 * personnel totals must always reconcile — regardless of how many people are
 * added or removed, and in which month they start or leave.
 *
 * Source of truth for a month's total cost is spreadPersonnel() (gross+bonus,
 * each grossed up by AG-NK). The split into wages/social (what actually lands
 * in plan_entries) must sum back to exactly that, month by month.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  spreadPersonnel, splitPersonnel, spreadPersonnelSplit, spreadPersonnelDrivers,
} from '../src/lib/plan-personnel.js';

const base = (o = {}) => ({
  employee_name:        'E',
  annual_gross_salary:  120000,
  payroll_burden_rate:  0,
  start_date:           null,
  end_date:             null,
  salary_increase_date: null,
  annual_gross_salary_post_increase: null,
  annual_bonus:         0,
  bonus_month:          12,
  ...o,
});

const round2 = n => Math.round(n * 100) / 100;

// Combined per-month total across drivers (the source of truth).
function monthlyCombined(drivers, year) {
  const m = new Map();
  for (let i = 1; i <= 12; i++) m.set(i, 0);
  for (const d of drivers)
    for (const e of spreadPersonnel(d, year))
      m.set(e.month, round2(m.get(e.month) + e.amount));
  return m;
}

// wages+social per month, from the split that feeds plan_entries.
function monthlySplit(drivers, year) {
  const { wages, social } = spreadPersonnelSplit(drivers, year);
  const m = new Map();
  for (let i = 1; i <= 12; i++) m.set(i, 0);
  for (const e of wages)  m.set(e.month, round2(m.get(e.month) + e.amount));
  for (const e of social) m.set(e.month, round2(m.get(e.month) + e.amount));
  return m;
}

function assertMonthlyReconciles(drivers, year) {
  const combined = monthlyCombined(drivers, year);
  const split    = monthlySplit(drivers, year);
  for (let m = 1; m <= 12; m++) {
    assert.equal(
      split.get(m), combined.get(m),
      `month ${m}: split (wages+social) ${split.get(m)} != combined ${combined.get(m)}`
    );
  }
}

// ── Invariant: split always reconciles with combined ──────────────────

describe('monthly reconciliation: wages + social == total cost', () => {
  it('single full-year employee with NK', () => {
    assertMonthlyReconciles([base({ payroll_burden_rate: 0.23 })], 2025);
  });

  it('employee with a bonus (NK on bonus too)', () => {
    assertMonthlyReconciles([base({ annual_bonus: 20000, bonus_month: 6, payroll_burden_rate: 0.23 })], 2025);
  });

  it('mid-month hire + mid-month leaver + salary increase', () => {
    assertMonthlyReconciles([
      base({ start_date: new Date('2025-03-16'), payroll_burden_rate: 0.2 }),
      base({ employee_name: 'B', end_date: new Date('2025-09-10'), payroll_burden_rate: 0.19 }),
      base({ employee_name: 'C', salary_increase_date: new Date('2025-07-01'),
             annual_gross_salary_post_increase: 150000, payroll_burden_rate: 0.21,
             annual_bonus: 12000, bonus_month: 3 }),
    ], 2025);
  });

  it('whole workforce with varied dates reconciles every month', () => {
    const drivers = [
      base({ employee_name: 'Anna',  annual_gross_salary: 90000,  payroll_burden_rate: 0.22 }),
      base({ employee_name: 'Ben',   annual_gross_salary: 72000,  payroll_burden_rate: 0.20, start_date: new Date('2025-04-01') }),
      base({ employee_name: 'Cara',  annual_gross_salary: 130000, payroll_burden_rate: 0.23, end_date: new Date('2025-08-31'), annual_bonus: 15000, bonus_month: 7 }),
      base({ employee_name: 'Dan',   annual_gross_salary: 60000,  payroll_burden_rate: 0.18, start_date: new Date('2025-02-10'), end_date: new Date('2025-11-20') }),
    ];
    assertMonthlyReconciles(drivers, 2025);
  });
});

// ── Bonus carries AG-NK ───────────────────────────────────────────────

describe('AG-NK is charged on the bonus', () => {
  it('social stream includes burden on bonus in bonus_month', () => {
    const { social } = splitPersonnel(base({ annual_bonus: 10000, bonus_month: 4, payroll_burden_rate: 0.25 }), 2025);
    const apr = social.find(e => e.month === 4);
    // April social = (salary 10000 + bonus 10000) * 0.25 = 5000
    assert.equal(apr.amount, 5000);
  });

  it('combined bonus month cost includes bonus grossed up by NK', () => {
    const entries = spreadPersonnel(base({ annual_bonus: 10000, bonus_month: 4, payroll_burden_rate: 0.25 }), 2025);
    const apr = entries.find(e => e.month === 4);
    // (salary 10000 + bonus 10000) * 1.25 = 25000
    assert.equal(apr.amount, 25000);
  });
});

// ── Adding an employee changes only the right months ─────────────────

describe('adding an employee', () => {
  it('mid-year hire raises only their active months, others unchanged', () => {
    const before = [base({ employee_name: 'A', annual_gross_salary: 120000, payroll_burden_rate: 0.2 })];
    const after  = [...before, base({ employee_name: 'B', annual_gross_salary: 60000, payroll_burden_rate: 0.2, start_date: new Date('2025-07-01') })];

    const mBefore = monthlyCombined(before, 2025);
    const mAfter  = monthlyCombined(after, 2025);

    for (let m = 1; m <= 6; m++)  assert.equal(mAfter.get(m), mBefore.get(m), `Jan–Jun month ${m} must be unchanged`);
    for (let m = 7; m <= 12; m++) assert.equal(mAfter.get(m), round2(mBefore.get(m) + 6000), `Jul–Dec month ${m} must rise by B's 5000*1.2`);

    assertMonthlyReconciles(after, 2025);
  });

  it('added employee starting mid-month is prorated in the join month', () => {
    const after = [
      base({ employee_name: 'A', payroll_burden_rate: 0.2 }),
      base({ employee_name: 'B', annual_gross_salary: 120000, payroll_burden_rate: 0.2, start_date: new Date('2025-09-16') }),
    ];
    const m = monthlyCombined(after, 2025);
    // Sep: A full 12000 + B prorated 15/30 * 10000 * 1.2 = 12000 + 6000 = 18000
    assert.equal(m.get(9), 18000);
    assert.equal(m.get(8), 12000);   // before B joined
    assert.equal(m.get(10), 24000);  // both full
    assertMonthlyReconciles(after, 2025);
  });
});

// ── Removing an employee changes only the right months ───────────────

describe('removing an employee', () => {
  it('removing one leaves the others exactly as if alone', () => {
    const a = base({ employee_name: 'A', annual_gross_salary: 120000, payroll_burden_rate: 0.2 });
    const b = base({ employee_name: 'B', annual_gross_salary: 90000, payroll_burden_rate: 0.2, start_date: new Date('2025-05-01'), annual_bonus: 9000, bonus_month: 12 });

    const both     = monthlyCombined([a, b], 2025);
    const onlyA    = monthlyCombined([a], 2025);
    const bAlone   = monthlyCombined([b], 2025);

    for (let m = 1; m <= 12; m++) {
      assert.equal(both.get(m), round2(onlyA.get(m) + bAlone.get(m)), `month ${m} sum must equal A+B`);
    }
    // After removing B, totals collapse back to exactly A.
    for (let m = 1; m <= 12; m++) assert.equal(round2(both.get(m) - bAlone.get(m)), onlyA.get(m));
    assertMonthlyReconciles([a], 2025);
  });

  it('removing a leaver zeroes months that were only theirs', () => {
    const leaver = base({ employee_name: 'Solo', end_date: new Date('2025-04-30'), payroll_burden_rate: 0.2 });
    const withLeaver = monthlyCombined([leaver], 2025);
    assert.ok(withLeaver.get(4) > 0);
    assert.equal(withLeaver.get(5), 0);
    // Remove → empty workforce → all months zero
    const empty = monthlyCombined([], 2025);
    for (let m = 1; m <= 12; m++) assert.equal(empty.get(m), 0);
  });
});

// ── Annual total integrity (no rounding drift over 12 months) ────────

describe('annual totals do not drift', () => {
  it('sum of split months equals sum of combined months', () => {
    const drivers = [
      base({ employee_name: 'A', annual_gross_salary: 123456, payroll_burden_rate: 0.233, annual_bonus: 7777, bonus_month: 5 }),
      base({ employee_name: 'B', annual_gross_salary: 98765,  payroll_burden_rate: 0.191, start_date: new Date('2025-06-11') }),
    ];
    const combined = monthlyCombined(drivers, 2025);
    const split    = monthlySplit(drivers, 2025);
    const sum = m => [...m.values()].reduce((s, v) => s + v, 0);
    assert.equal(round2(sum(split)), round2(sum(combined)));
  });

  it('spreadPersonnelDrivers per-month equals combined per-month', () => {
    const drivers = [
      base({ employee_name: 'A', payroll_burden_rate: 0.2, annual_bonus: 12000, bonus_month: 11 }),
      base({ employee_name: 'B', annual_gross_salary: 60000, payroll_burden_rate: 0.2, start_date: new Date('2025-03-01') }),
    ];
    const merged = spreadPersonnelDrivers(drivers, 2025);
    const combined = monthlyCombined(drivers, 2025);
    for (const e of merged) assert.equal(e.amount, combined.get(e.month), `month ${e.month}`);
  });
});
