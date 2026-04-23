/**
 * Revenue spreading engine — pure functions, no DB dependencies.
 *
 * Converts a typed revenue driver into an array of monthly planned amounts.
 * Consumers call spreadDriver() or spreadDrivers() and then upsert the result
 * into plan_entries, skipping months flagged is_manual_override=true.
 */

/**
 * Return the number of calendar days in a given month.
 * @param {number} year
 * @param {number} month  1-based
 */
export function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * Clamp a date to [firstOfMonth, lastOfMonth] and return the fraction of
 * the month that falls within [start, end] (0.0 – 1.0).
 *
 * Full month  → 1.0
 * Not covered → 0.0
 * Partial     → days_covered / days_in_month
 *
 * @param {number} year
 * @param {number} month   1-based
 * @param {Date|null} start  null = no lower bound (treat as start of year)
 * @param {Date|null} end    null = no upper bound (treat as end of year)
 */
export function monthFraction(year, month, start, end) {
  const firstOfMonth = new Date(year, month - 1, 1);
  const lastOfMonth  = new Date(year, month - 1, daysInMonth(year, month));

  const effectiveStart = start ? new Date(Math.max(start.getTime(), firstOfMonth.getTime())) : firstOfMonth;
  const effectiveEnd   = end   ? new Date(Math.min(end.getTime(),   lastOfMonth.getTime()))  : lastOfMonth;

  if (effectiveStart > effectiveEnd) return 0;

  const coveredDays = Math.round((effectiveEnd - effectiveStart) / 86400000) + 1;
  return coveredDays / daysInMonth(year, month);
}

/**
 * Count how many full or partial months are active within [start, end] for a
 * given year, weighted by fraction. Used to distribute annual_fee amounts.
 *
 * @param {number} year
 * @param {Date|null} start
 * @param {Date|null} end
 * @returns {number}  sum of monthFraction() across all 12 months
 */
export function activeMonthWeight(year, start, end) {
  let total = 0;
  for (let m = 1; m <= 12; m++) total += monthFraction(year, m, start, end);
  return total;
}

/**
 * Spread one revenue driver into monthly amounts for a given plan year.
 *
 * Returns an array of { month, year, amount } for months where amount > 0.
 * Months outside the driver's date range produce no entry (not zero entries).
 *
 * @param {object} driver
 * @param {string}    driver.driver_type   'annual_fee' | 'monthly_flat' | 'one_off' | 'quarterly_flat'
 * @param {number}    driver.amount
 * @param {Date|null} driver.start_date
 * @param {Date|null} driver.end_date
 * @param {string}    driver.spread_method  'even' (only supported value now)
 * @param {number} planYear
 * @returns {{ month: number, year: number, amount: number }[]}
 */
export function spreadDriver(driver, planYear) {
  const { driver_type, amount, start_date, end_date } = driver;

  // Normalise: dates may arrive as strings from the DB
  const start = start_date ? new Date(start_date) : null;
  const end   = end_date   ? new Date(end_date)   : null;

  // Clamp to the plan year so callers don't need to pre-filter
  const yearStart = new Date(planYear, 0, 1);
  const yearEnd   = new Date(planYear, 11, 31);
  const effectiveStart = start ? new Date(Math.max(start.getTime(), yearStart.getTime())) : yearStart;
  const effectiveEnd   = end   ? new Date(Math.min(end.getTime(),   yearEnd.getTime()))   : yearEnd;

  if (effectiveStart > effectiveEnd) return []; // driver entirely outside plan year

  const result = [];

  if (driver_type === 'one_off') {
    // Place the full amount in the month of start_date (or January if no start).
    const targetMonth = effectiveStart.getMonth() + 1; // 1-based
    result.push({ month: targetMonth, year: planYear, amount: Number(amount) });
    return result;
  }

  if (driver_type === 'monthly_flat') {
    for (let m = 1; m <= 12; m++) {
      const frac = monthFraction(planYear, m, effectiveStart, effectiveEnd);
      if (frac <= 0) continue;
      // For monthly_flat, partial months receive a prorated share of the monthly rate
      result.push({ month: m, year: planYear, amount: round2(Number(amount) * frac) });
    }
    return result;
  }

  // quarterly_flat: place amount in the first active month of each calendar quarter
  if (driver_type === 'quarterly_flat') {
    const quarterStarts = [1, 4, 7, 10]; // Jan, Apr, Jul, Oct
    for (const qStart of quarterStarts) {
      const qEnd = qStart + 2; // inclusive last month of quarter
      // Find the first month within this quarter that overlaps the effective range
      for (let m = qStart; m <= qEnd; m++) {
        const frac = monthFraction(planYear, m, effectiveStart, effectiveEnd);
        if (frac > 0) {
          result.push({ month: m, year: planYear, amount: Number(amount) });
          break;
        }
      }
    }
    return result;
  }

  // annual_fee: distribute amount proportionally across active months
  if (driver_type === 'annual_fee') {
    const totalWeight = activeMonthWeight(planYear, effectiveStart, effectiveEnd);
    if (totalWeight === 0) return [];

    let distributed = 0;
    const months = [];

    for (let m = 1; m <= 12; m++) {
      const frac = monthFraction(planYear, m, effectiveStart, effectiveEnd);
      if (frac <= 0) continue;
      months.push({ month: m, frac });
    }

    // Distribute proportionally, assign remainder to last active month
    for (let i = 0; i < months.length; i++) {
      const { month, frac } = months[i];
      const isLast = i === months.length - 1;
      const monthAmount = isLast
        ? round2(Number(amount) - distributed)
        : round2(Number(amount) * (frac / totalWeight));
      distributed += monthAmount;
      result.push({ month, year: planYear, amount: monthAmount });
    }
    return result;
  }

  return [];
}

/**
 * Spread multiple drivers and merge into a single monthly map.
 * Amounts for the same month are summed (multiple drivers on one line item
 * are additive — e.g. base fee + top-up fee).
 *
 * @param {object[]} drivers
 * @param {number}   planYear
 * @returns {{ month: number, year: number, amount: number }[]}
 */
export function spreadDrivers(drivers, planYear) {
  const byMonth = new Map(); // month → amount
  for (const d of drivers) {
    for (const entry of spreadDriver(d, planYear)) {
      byMonth.set(entry.month, (byMonth.get(entry.month) || 0) + entry.amount);
    }
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a - b)
    .map(([month, amount]) => ({ month, year: planYear, amount: round2(amount) }));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
