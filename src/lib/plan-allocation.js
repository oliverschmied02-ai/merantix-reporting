/**
 * Cost allocation engine — pure functions, no DB dependencies.
 *
 * Takes a source monthly series and a set of allocation targets, and produces
 * an array of monthly allocated amounts per target.
 *
 * Three methods are supported:
 *
 *   fixed_pct   — each target receives (pct_share / 100) × source_amount.
 *                 Percentages may sum to < 100 (remainder stays at source).
 *                 Must not sum to > 100.
 *
 *   equal_split — source_amount / n_targets per target, rounding remainder to
 *                 the first target to avoid penny drift.
 *
 *   manual      — allocated_amount is taken directly from target.manual_amounts
 *                 keyed by month. Any month without an entry produces 0.
 *
 * All functions return:
 *   { target_id, label, month, year, source_amount, allocated_amount }[]
 */

/**
 * @typedef {{ month: number, year: number, amount: number }} MonthlyAmount
 * @typedef {{
 *   id:             number,
 *   label:          string,
 *   pct_share?:     number,           // required for fixed_pct
 *   manual_amounts?: Record<number,number>  // month→amount, for manual method
 * }} AllocationTarget
 */

/**
 * Allocate source monthly amounts across targets using the specified method.
 *
 * @param {MonthlyAmount[]}     sourceEntries  monthly source amounts
 * @param {AllocationTarget[]}  targets
 * @param {'fixed_pct'|'equal_split'|'manual'} method
 * @returns {{ target_id: number, label: string, month: number, year: number,
 *             source_amount: number, allocated_amount: number }[]}
 */
export function allocate(sourceEntries, targets, method) {
  if (!targets.length || !sourceEntries.length) return [];

  if (method === 'fixed_pct') return allocateFixedPct(sourceEntries, targets);
  if (method === 'equal_split') return allocateEqualSplit(sourceEntries, targets);
  if (method === 'manual') return allocateManual(sourceEntries, targets);

  throw new Error(`Unknown allocation method: ${method}`);
}

function allocateFixedPct(sourceEntries, targets) {
  const totalPct = targets.reduce((s, t) => s + (Number(t.pct_share) || 0), 0);
  if (totalPct > 100.0001) {
    throw new Error(`fixed_pct shares sum to ${totalPct.toFixed(4)}%, must be ≤ 100`);
  }

  const result = [];
  for (const src of sourceEntries) {
    for (const t of targets) {
      const pct = Number(t.pct_share) || 0;
      result.push({
        target_id:        t.id,
        label:            t.label,
        month:            src.month,
        year:             src.year,
        source_amount:    src.amount,
        allocated_amount: round2(src.amount * pct / 100),
      });
    }
  }
  return result;
}

function allocateEqualSplit(sourceEntries, targets) {
  const n = targets.length;
  const result = [];

  for (const src of sourceEntries) {
    const baseShare = round2(src.amount / n);
    const remainder = round2(src.amount - baseShare * n);

    targets.forEach((t, i) => {
      // Penny remainder goes to the first target
      const amount = i === 0 ? round2(baseShare + remainder) : baseShare;
      result.push({
        target_id:        t.id,
        label:            t.label,
        month:            src.month,
        year:             src.year,
        source_amount:    src.amount,
        allocated_amount: amount,
      });
    });
  }
  return result;
}

function allocateManual(sourceEntries, targets) {
  const result = [];
  const srcByMonth = new Map(sourceEntries.map(e => [e.month, e]));

  for (const t of targets) {
    const manualAmounts = t.manual_amounts || {};
    for (const [month, amount] of Object.entries(manualAmounts)) {
      const m = Number(month);
      const src = srcByMonth.get(m);
      if (!src) continue;
      result.push({
        target_id:        t.id,
        label:            t.label,
        month:            m,
        year:             src.year,
        source_amount:    src.amount,
        allocated_amount: round2(Number(amount)),
      });
    }
  }

  // Sort by target then month for deterministic output
  return result.sort((a, b) => a.target_id - b.target_id || a.month - b.month);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
