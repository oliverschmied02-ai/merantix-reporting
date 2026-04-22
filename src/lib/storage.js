import { APP } from '../state.js';
import { DEFAULT_PL_DEF } from '../data/default-pl.js';
import { deepClone } from './utils.js';
import { rebuildAcctMap } from './resolve.js';
import { getSetting, saveSetting } from './db.js';

// Persist to server (fire-and-forget) + keep localStorage as offline cache
function persistSetting(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
  saveSetting(key, value).catch(() => {}); // best-effort
}

export async function loadAppState() {
  // Try server first; fall back to localStorage, then hardcoded defaults
  try {
    const [serverCoA, serverRules] = await Promise.all([
      getSetting('gdpdu_coa_v1'),
      getSetting('gdpdu_rules_v1'),
    ]);

    if (serverCoA) {
      APP.plDef = serverCoA;
      localStorage.setItem('gdpdu_coa_v1', JSON.stringify(serverCoA));
    } else {
      const local = localStorage.getItem('gdpdu_coa_v1');
      APP.plDef = local ? JSON.parse(local) : deepClone(DEFAULT_PL_DEF);
    }

    if (serverRules) {
      APP.rules = serverRules;
      localStorage.setItem('gdpdu_rules_v1', JSON.stringify(serverRules));
    } else {
      const local = localStorage.getItem('gdpdu_rules_v1');
      APP.rules = local ? JSON.parse(local) : [];
    }
  } catch {
    // Server unreachable — use localStorage fallback
    try {
      const coa = localStorage.getItem('gdpdu_coa_v1');
      APP.plDef = coa ? JSON.parse(coa) : deepClone(DEFAULT_PL_DEF);
    } catch { APP.plDef = deepClone(DEFAULT_PL_DEF); }
    try {
      const rules = localStorage.getItem('gdpdu_rules_v1');
      APP.rules = rules ? JSON.parse(rules) : [];
    } catch { APP.rules = []; }
  }
  rebuildAcctMap();
}

export function saveCoA() {
  persistSetting('gdpdu_coa_v1', APP.plDef);
  rebuildAcctMap();
  import('../ui/pl-table.js').then(m => m.buildPL());
  import('../ui/settings.js').then(m => m.renderCoATree());
}

export function saveRules() {
  persistSetting('gdpdu_rules_v1', APP.rules);
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
