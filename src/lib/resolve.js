import { APP } from '../state.js';

export function rebuildAcctMap() {
  APP.acctMap = new Map();
  for (const item of APP.plDef) {
    if (!item.subs) continue;
    for (const sub of item.subs) {
      const nb = sub.normalBalance || item.normalBalance || 'S';
      for (const a of sub.accounts || []) {
        APP.acctMap.set(a, { itemId: item.id, subId: sub.id, normalBalance: nb });
      }
    }
  }
}

export function getFieldVal(txn, field) {
  switch (field) {
    case 'text':   return txn.text;
    case 'beleg':  return txn.beleg;
    case 'ktonr':  return txn.ktonr;
    case 'gktonr': return txn.gktonr;
    case 'stapel': return txn.stapelRaw;
    default:       return txn.text;
  }
}

export function resolveMapping(txn) {
  if (txn._directMapping) {
    const item = APP.plDef.find(i => i.id === txn._directMapping.itemId);
    const sub  = item?.subs?.find(s => s.id === txn._directMapping.subId);
    return {
      itemId: txn._directMapping.itemId,
      subId:  txn._directMapping.subId,
      normalBalance: sub?.normalBalance || item?.normalBalance || 'S',
    };
  }
  for (const rule of APP.rules) {
    if (!rule.enabled) continue;
    const fieldVal = getFieldVal(txn, rule.matchField);
    const matchVal = (rule.matchValue || '').toLowerCase();
    const fv = String(fieldVal || '').toLowerCase();
    let hit = false;
    if      (rule.matchOp === 'contains') hit = fv.includes(matchVal);
    else if (rule.matchOp === 'equals')   hit = fv === matchVal;
    else if (rule.matchOp === 'starts')   hit = fv.startsWith(matchVal);
    else if (rule.matchOp === 'any')
      hit = ['text','beleg','ktonr','gktonr','stapel'].some(f =>
        String(getFieldVal(txn, f)).toLowerCase().includes(matchVal));
    if (hit) {
      const item = APP.plDef.find(i => i.id === rule.targetItemId);
      const sub  = item?.subs?.find(s => s.id === rule.targetSubId);
      return {
        itemId: rule.targetItemId,
        subId:  rule.targetSubId,
        normalBalance: sub?.normalBalance || item?.normalBalance || 'S',
      };
    }
  }
  return APP.acctMap.get(txn.ktonr) || null;
}

export function getRulesAffectingItem(itemId) {
  return APP.rules.filter(r => r.enabled && r.targetItemId === itemId);
}
