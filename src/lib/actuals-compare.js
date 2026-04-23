/**
 * Actuals extraction for Ist-vs-Plan comparison.
 *
 * Bridges the existing P&L computation engine (computePLSingle / computeAllPeriods)
 * into the same Map<category, {month: amount}> shape that aggregateByCategory()
 * produces for plan data. This lets compareVersions() diff them without any
 * additional logic.
 *
 * Category mapping (plan category → P&L section id):
 *   revenue   → computed['revenue']     (positive = income)
 *   personnel → computed['personnel']   (positive = spend, absolute)
 *   opex      → computed['opex']        (positive = spend, absolute)
 *   allocation→ 0                       (no P&L section in default chart)
 *   ebitda    → computed['ebitda']      (derived: revenue - personnel - opex)
 *   other     → 0                       (no catch-all section yet)
 *
 * EBITDA in plan-compare.js is re-derived from plan category sums, but for
 * actuals we use the already-computed ebitda value from computePLSingle so
 * that any custom formula in plDef is honoured.
 */

import { COMPARE_ROWS } from './plan-compare.js';

// Which P&L computed keys map to which plan categories
const CATEGORY_TO_PL_KEY = {
  revenue:    'revenue',
  personnel:  'personnel',
  opex:       'opex',
  // allocation has no direct P&L account group — returns 0
  // ebitda is handled specially below
  // other has no direct mapping — returns 0
};

/**
 * Convert an array of monthly PL results (from computeAllPeriods().periodPLs)
 * into the category→month map consumed by compareVersions().
 *
 * @param {Array<{computed: Record<string,number>}>} periodPLs
 *   One entry per month (index 0 = January, index 11 = December).
 *   May be shorter than 12 (partial year); missing months default to 0.
 * @returns {Map<string, Record<number,number>>}  category → { 1..12: amount }
 */
export function extractActualsFromPeriods(periodPLs) {
  const result = new Map();

  for (const row of COMPARE_ROWS) {
    result.set(row.key, {});
    for (let m = 1; m <= 12; m++) result.get(row.key)[m] = 0;
  }

  for (let i = 0; i < Math.min(periodPLs.length, 12); i++) {
    const month   = i + 1;
    const computed = periodPLs[i]?.computed ?? {};

    // Standard category → P&L key mappings
    for (const [cat, plKey] of Object.entries(CATEGORY_TO_PL_KEY)) {
      const val = computed[plKey] ?? 0;
      result.get(cat)[month] = round2(val);
    }

    // EBITDA: use the P&L engine's own value (honours custom formulas)
    result.get('ebitda')[month] = round2(computed['ebitda'] ?? 0);

    // allocation and other default to 0 — left in the map for consistent shape
  }

  return result;
}

/**
 * Extract YTD actuals for a given month range from periodPLs.
 * Returns a single-row comparison (annual totals only).
 *
 * Useful for a YTD summary card at the top of the table.
 *
 * @param {Array<{computed: Record<string,number>}>} periodPLs
 * @param {number} upToMonth  1-based, inclusive (e.g. 6 = Jan–Jun)
 * @returns {Record<string,number>}  category → YTD amount
 */
export function extractActualsYTD(periodPLs, upToMonth) {
  const ytd = {};
  for (const row of COMPARE_ROWS) ytd[row.key] = 0;

  for (let i = 0; i < Math.min(periodPLs.length, upToMonth); i++) {
    const computed = periodPLs[i]?.computed ?? {};
    for (const [cat, plKey] of Object.entries(CATEGORY_TO_PL_KEY)) {
      ytd[cat] = round2((ytd[cat] || 0) + (computed[plKey] ?? 0));
    }
    // EBITDA is not simply summable — re-derive from accumulated revenue/personnel/opex
  }

  // Re-derive YTD EBITDA from components (avoids double-counting allocation)
  ytd['ebitda'] = round2(ytd['revenue'] - ytd['personnel'] - ytd['opex'] - (ytd['allocation'] || 0));
  return ytd;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
