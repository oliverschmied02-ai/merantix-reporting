/**
 * Plan comparison engine — pure functions, no DOM or DB dependencies.
 *
 * Aggregates two plan version datasets (lineItems + entries) into a
 * comparison structure with monthly and annual totals per category,
 * plus EBITDA derived from revenue − personnel − opex.
 *
 * Sign convention (matches plan-entries storage):
 *   Revenue line items  → positive = income
 *   Cost line items     → positive stored value = cost (displayed as negative in P&L)
 *
 * For the comparison view we show costs as POSITIVE numbers (actual spend)
 * and use the sign for variance: positive variance = A is higher than B.
 */

export const COMPARE_ROWS = [
  { key: 'revenue',      label: 'Umsatz',          sign: +1 },
  { key: 'personnel',    label: 'Personalaufwand',  sign: -1 },
  { key: 'opex',         label: 'OpEx',             sign: -1 },
  { key: 'ebitda',       label: 'EBITDA',           sign: null, computed: true },
  { key: 'depreciation', label: 'Abschreibungen',   sign: -1 },
];

const COST_CATEGORIES = new Set(['personnel', 'opex', 'depreciation']);

/**
 * Build a monthly totals map from line items + entries for one version.
 *
 * @param {object[]} lineItems  — from getPlanLineItems
 * @param {object[]} entries    — from getPlanEntries (all months)
 * @returns {Map<string, Record<number,number>>}  category → { month: amount }
 */
export function aggregateByCategory(lineItems, entries) {
  // Build lookup: line_item_id → category
  const liCat = new Map(lineItems.map(li => [li.id, li.category]));

  // Accumulate: category → month → amount
  const result = new Map();
  for (const row of COMPARE_ROWS) {
    result.set(row.key, {});
    for (let m = 1; m <= 12; m++) result.get(row.key)[m] = 0;
  }

  for (const e of entries) {
    const cat = liCat.get(e.line_item_id);
    if (!cat || !result.has(cat)) continue;
    result.get(cat)[e.month] = (result.get(cat)[e.month] || 0) + Number(e.amount);
  }

  // Compute EBITDA = revenue - personnel - opex (before depreciation, by definition)
  for (let m = 1; m <= 12; m++) {
    result.get('ebitda')[m] =
      (result.get('revenue')[m]   || 0) -
      (result.get('personnel')[m] || 0) -
      (result.get('opex')[m]      || 0);
  }

  return result;
}

/**
 * Compute annual totals for each category from a monthly map.
 *
 * @param {Map<string, Record<number,number>>} monthly
 * @returns {Record<string, number>}
 */
export function annualTotals(monthly) {
  const out = {};
  for (const [cat, byMonth] of monthly.entries()) {
    out[cat] = Object.values(byMonth).reduce((s, v) => s + v, 0);
  }
  return out;
}

/**
 * Compute the full comparison between two aggregated version datasets.
 *
 * Returns one row per COMPARE_ROWS entry, each with:
 *   monthly: { [month]: { a, b, delta, pct } }
 *   annual:  { a, b, delta, pct }
 *
 * delta = b − a  (positive = B is larger)
 * pct   = delta / |a| × 100  (null if a === 0)
 *
 * @param {Map} monthlyA
 * @param {Map} monthlyB
 * @returns {object[]}
 */
export function compareVersions(monthlyA, monthlyB) {
  return COMPARE_ROWS.map(row => {
    const catA = monthlyA.get(row.key) || {};
    const catB = monthlyB.get(row.key) || {};

    const monthly = {};
    for (let m = 1; m <= 12; m++) {
      const a = catA[m] || 0;
      const b = catB[m] || 0;
      monthly[m] = { a, b, ...variance(a, b) };
    }

    const totA = Object.values(catA).reduce((s, v) => s + v, 0);
    const totB = Object.values(catB).reduce((s, v) => s + v, 0);

    return {
      ...row,
      monthly,
      annual: { a: totA, b: totB, ...variance(totA, totB) },
    };
  });
}

function variance(a, b) {
  const delta = round2(b - a);
  const pct   = a === 0 ? null : round2((delta / Math.abs(a)) * 100);
  return { delta, pct };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
