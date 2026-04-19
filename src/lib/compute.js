import { APP } from '../state.js';
import { MONTH_SHORT } from './utils.js';
import { resolveMapping } from './resolve.js';

export function isInGUV(n) {
  return (n >= 400000 && n <= 499999) || (n >= 600000 && n <= 799999);
}

export function computePLSingle(txns) {
  const subBal = new Map();
  const unmapped = new Set();

  for (const t of txns) {
    const mapping = resolveMapping(t);
    if (!mapping) {
      if (isInGUV(t.ktonr)) unmapped.add(t.ktonr);
      continue;
    }
    const key = mapping.itemId + '::' + mapping.subId;
    if (!subBal.has(key)) subBal.set(key, { soll: 0, haben: 0, byAccount: {}, nb: mapping.normalBalance });
    const b = subBal.get(key);
    b.soll  += t.soll;
    b.haben += t.haben;
    const acct = t.ktonr;
    if (!b.byAccount[acct]) b.byAccount[acct] = { soll: 0, haben: 0, txns: [] };
    b.byAccount[acct].soll  += t.soll;
    b.byAccount[acct].haben += t.haben;
    b.byAccount[acct].txns.push(t);
  }

  function netAmt(soll, haben, nb) {
    return nb === 'H' ? haben - soll : soll - haben;
  }

  const vals = {};
  for (const item of APP.plDef) {
    if (item.type === 'computed' || item.type === 'ratio') continue;
    const bySubId = {};
    let itemAmt = 0;
    for (const sub of item.subs) {
      const nb  = sub.normalBalance || item.normalBalance || 'S';
      const key = item.id + '::' + sub.id;
      const b   = subBal.get(key);
      const subAmt = b ? netAmt(b.soll, b.haben, nb) : 0;
      const byAccount = {};
      if (b) {
        for (const [acctStr, ab] of Object.entries(b.byAccount)) {
          byAccount[+acctStr] = { amount: netAmt(ab.soll, ab.haben, nb), txns: ab.txns };
        }
      }
      bySubId[sub.id] = { amount: subAmt, byAccount };
      itemAmt += subAmt;
    }
    vals[item.id] = { amount: itemAmt, bySubId };
  }

  const computed = {};
  function getVal(id) {
    if (computed[id] !== undefined) return computed[id];
    const item = APP.plDef.find(x => x.id === id);
    if (!item) return 0;
    if (item.type === 'computed') {
      let v = 0;
      for (const [dep, sign] of item.formula) v += getVal(dep) * sign;
      computed[id] = v;
      return v;
    }
    if (item.type === 'ratio') {
      const num = getVal(item.numerator);
      const den = getVal(item.denominator);
      computed[id] = den !== 0 ? (num / Math.abs(den)) * 100 : null;
      return computed[id];
    }
    if (item.type === 'section_mixed') {
      let v = 0;
      for (const sub of item.subs) {
        const sa = vals[id]?.bySubId[sub.id]?.amount || 0;
        v += sub.normalBalance === 'H' ? sa : -sa;
      }
      computed[id] = v;
      return v;
    }
    const raw = vals[id]?.amount || 0;
    computed[id] = raw;
    return raw;
  }
  for (const item of APP.plDef) getVal(item.id);

  return { vals, computed, unmapped };
}

export function computeAllPeriods() {
  const year = parseInt(document.getElementById('year-sel').value);
  const mode = APP.viewMode;
  if (!year) return null;

  const yearTxns = APP.allTransactions.filter(t => t.wjYear === year);
  const numP = mode === 'monat' ? 12 : 4;
  const periodPLs = [];
  const periods   = [];

  for (let p = 1; p <= numP; p++) {
    const pTxns = mode === 'monat'
      ? yearTxns.filter(t => t.wjMonth === p)
      : yearTxns.filter(t => t.wjMonth && Math.ceil(t.wjMonth / 3) === p);
    periodPLs.push(computePLSingle(pTxns));
    periods.push({ label: mode === 'monat' ? MONTH_SHORT[p - 1] : `Q${p}`, idx: p, txns: pTxns });
  }

  const ytdPL = computePLSingle(yearTxns);
  return { periodPLs, ytdPL, periods, year, mode };
}
