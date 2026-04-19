import { APP } from '../state.js';
import { DEFAULT_PL_DEF } from '../data/default-pl.js';
import { deepClone } from './utils.js';
import { rebuildAcctMap } from './resolve.js';

export function loadAppState() {
  try {
    const coa = localStorage.getItem('gdpdu_coa_v1');
    if (coa) APP.plDef = JSON.parse(coa);
    else APP.plDef = deepClone(DEFAULT_PL_DEF);
  } catch {
    APP.plDef = deepClone(DEFAULT_PL_DEF);
  }
  try {
    const rules = localStorage.getItem('gdpdu_rules_v1');
    if (rules) APP.rules = JSON.parse(rules);
    else APP.rules = [];
  } catch {
    APP.rules = [];
  }
  rebuildAcctMap();
}

export function saveCoA() {
  localStorage.setItem('gdpdu_coa_v1', JSON.stringify(APP.plDef));
  rebuildAcctMap();
  // imported lazily to avoid circular deps
  import('../ui/pl-table.js').then(m => m.buildPL());
  import('../ui/settings.js').then(m => m.renderCoATree());
}

export function saveRules() {
  localStorage.setItem('gdpdu_rules_v1', JSON.stringify(APP.rules));
  import('../ui/pl-table.js').then(m => m.buildPL());
}

export const KPI_DEFAULT_ORDER = ['revenue', 'ebitda', 'ebit', 'ebt', 'personnel'];

export function loadKpiOrder() {
  try {
    const s = localStorage.getItem('gdpdu_kpi_order');
    if (s) return JSON.parse(s);
  } catch {}
  return [...KPI_DEFAULT_ORDER];
}

export function saveKpiOrder(order) {
  APP.kpiOrder = order;
  localStorage.setItem('gdpdu_kpi_order', JSON.stringify(order));
}
