/**
 * Personnel cost spreading engine — pure functions, no DB dependencies.
 *
 * Converts a typed personnel driver (one employee or planned hire) into an
 * array of monthly planned cost amounts.  Consumers call spreadPersonnel()
 * or spreadPersonnelDrivers() and upsert the result into plan_entries,
 * skipping months flagged is_manual_override=true.
 *
 * Salary / bonus treatment
 * ────────────────────────
 * Monthly gross        = annual_gross_salary / 12
 * Partial months       = monthly_gross × monthFraction(start, end)
 * Employer burden      = monthly_gross_for_month × payroll_burden_rate
 * Monthly total        = monthly_gross_for_month × (1 + payroll_burden_rate)
 *
 * Salary increase      Months are evaluated against two salary bands:
 *   before salary_increase_date  → annual_gross_salary / 12
 *   from  salary_increase_date   → annual_gross_salary_post_increase / 12
 *   A month straddling the date is split at the day boundary; each portion
 *   is prorated separately and summed.
 *
 * Bonus                annual_bonus placed as a lump sum in bonus_month.
 *   Condition: employee must be active (start ≤ bonus month end AND
 *   end ≥ bonus month start) for any portion of bonus_month.
 *   No pro-ration: a partial bonus month still pays the full bonus.
 *   Burden is NOT applied to the bonus (common practice; adjust if needed).
 *
 * Open / planned hire  Treated identically to filled roles.
 *   is_filled=false has no effect on amounts — it is a UI/reporting flag only.
 */

import { monthFraction, daysInMonth } from './plan-revenue.js';

/**
 * Compute the monthly salary cost for one month, accounting for a possible
 * mid-month salary increase.
 *
 * Returns gross cost for the month (before burden). Burden is applied by
 * the caller to keep this function single-responsibility.
 *
 * @param {number}    year
 * @param {number}    month           1-based
 * @param {Date|null} empStart        employment start (null = start of year)
 * @param {Date|null} empEnd          employment end   (null = end of year)
 * @param {number}    annualSalary    pre-increase salary
 * @param {Date|null} increaseDate    date salary increase takes effect
 * @param {number|null} salaryPost    post-increase annual salary
 * @returns {number}
 */
export function monthlyGross(year, month, empStart, empEnd, annualSalary, increaseDate, salaryPost) {
  const monthlyBase = annualSalary / 12;

  // No increase configured — straightforward proration
  if (!increaseDate || !salaryPost) {
    return round2(monthlyBase * monthFraction(year, month, empStart, empEnd));
  }

  const incDate    = new Date(increaseDate);
  const firstOfMon = new Date(year, month - 1, 1);
  const lastOfMon  = new Date(year, month - 1, daysInMonth(year, month));

  // Increase takes effect after this month entirely → use base salary
  if (incDate > lastOfMon) {
    return round2(monthlyBase * monthFraction(year, month, empStart, empEnd));
  }

  // Increase took effect before this month entirely → use new salary
  if (incDate <= firstOfMon) {
    return round2((salaryPost / 12) * monthFraction(year, month, empStart, empEnd));
  }

  // Increase falls within this month — split at increase date
  // Pre-increase portion: [effective start, day before increase]
  const dayBeforeIncrease = new Date(incDate.getTime() - 86400000);
  const preFrac  = monthFraction(year, month, empStart,
    empEnd ? new Date(Math.min(empEnd.getTime(), dayBeforeIncrease.getTime())) : dayBeforeIncrease);
  const postFrac = monthFraction(year, month, incDate,
    empEnd ?? null);

  return round2((monthlyBase * preFrac) + ((salaryPost / 12) * postFrac));
}

/**
 * Spread one personnel driver across all months of planYear.
 *
 * Returns an array of { month, year, amount } — one entry per month where
 * cost > 0.  Months outside the driver's employment dates produce no entry.
 *
 * @param {object} driver
 * @param {string}      driver.employee_name
 * @param {number}      driver.annual_gross_salary
 * @param {number}      driver.payroll_burden_rate          0.0 – 1.0+
 * @param {Date|string|null} driver.start_date
 * @param {Date|string|null} driver.end_date
 * @param {Date|string|null} driver.salary_increase_date
 * @param {number|null} driver.annual_gross_salary_post_increase
 * @param {number}      driver.annual_bonus                 0 if none
 * @param {number}      driver.bonus_month                  1-based, default 12
 * @param {number} planYear
 * @returns {{ month: number, year: number, amount: number }[]}
 */
export function spreadPersonnel(driver, planYear) {
  const {
    annual_gross_salary,
    payroll_burden_rate  = 0,
    annual_bonus         = 0,
    bonus_month          = 12,
    salary_increase_date = null,
    annual_gross_salary_post_increase = null,
  } = driver;

  const start = driver.start_date ? new Date(driver.start_date) : null;
  const end   = driver.end_date   ? new Date(driver.end_date)   : null;
  const increaseDate = salary_increase_date ? new Date(salary_increase_date) : null;
  const salaryPost   = annual_gross_salary_post_increase
    ? Number(annual_gross_salary_post_increase) : null;

  const burden = Number(payroll_burden_rate);
  const result = [];

  for (let m = 1; m <= 12; m++) {
    const gross = monthlyGross(
      planYear, m, start, end,
      Number(annual_gross_salary), increaseDate, salaryPost
    );

    if (gross <= 0) continue;

    const totalCost = round2(gross * (1 + burden));
    result.push({ month: m, year: planYear, amount: totalCost });
  }

  // Bonus: lump sum in bonus_month if employee is active any part of that month
  if (Number(annual_bonus) > 0) {
    const bonusFrac = monthFraction(planYear, bonus_month, start, end);
    if (bonusFrac > 0) {
      const existing = result.find(e => e.month === bonus_month);
      if (existing) {
        existing.amount = round2(existing.amount + Number(annual_bonus));
      } else {
        result.push({ month: bonus_month, year: planYear, amount: Number(annual_bonus) });
        result.sort((a, b) => a.month - b.month);
      }
    }
  }

  return result;
}

/**
 * Spread multiple personnel drivers and sum by month.
 * Suitable for generating a version-level personnel total across all employees.
 *
 * @param {object[]} drivers
 * @param {number}   planYear
 * @returns {{ month: number, year: number, amount: number }[]}
 */
export function spreadPersonnelDrivers(drivers, planYear) {
  const byMonth = new Map();
  for (const d of drivers) {
    for (const entry of spreadPersonnel(d, planYear)) {
      byMonth.set(entry.month, round2((byMonth.get(entry.month) || 0) + entry.amount));
    }
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a - b)
    .map(([month, amount]) => ({ month, year: planYear, amount }));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
