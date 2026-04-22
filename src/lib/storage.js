import { APP } from '../state.js';
import { DEFAULT_PL_DEF } from '../data/default-pl.js';
import { deepClone } from './utils.js';
import { rebuildAcctMap } from './resolve.js';
import { getSetting, saveSetting } from './db.js';

function persistSetting(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
  saveSetting(key, value).catch(() => {}); // best-effort, non-blocking
}

// Load from localStorage synchronously (instant), then sync server settings in background.
// The background sync updates APP state and re-renders if the server has newer data.
export function loadAppState() {
  try {
    const coa = localStorage.getItem('gdpdu_coa_v1');
    APP.plDef = coa ? JSON.parse(coa) : deepClone(DEFAULT_PL_DEF);
  } catch { APP.plDef = deepClone(DEFAULT_PL_DEF); }
  try {
    const rules = localStorage.getItem('gdpdu_rules_v1');
    APP.rules = rules ? JSON.parse(rules) : [];
  } catch { APP.rules = []; }
  rebuildAcctMap();

  // Background sync: pull server settings and re-render only if they differ
  syncSettingsFromServer().catch(() => {});
}

async function syncSettingsFromServer() {
  const [serverCoA, serverRules] = await Promise.all([
    getSetting('gdpdu_coa_v1'),
    getSetting('gdpdu_rules_v1'),
  ]);

  let changed = false;

  if (serverCoA) {
    const current = JSON.stringify(APP.plDef);
    const incoming = JSON.stringify(serverCoA);
    if (current !== incoming) {
      APP.plDef = serverCoA;
      localStorage.setItem('gdpdu_coa_v1', incoming);
      changed = true;
    }
  }

  if (serverRules) {
    const current = JSON.stringify(APP.rules);
    const incoming = JSON.stringify(serverRules);
    if (current !== incoming) {
      APP.rules = serverRules;
      localStorage.setItem('gdpdu_rules_v1', incoming);
      changed = true;
    }
  }

  if (changed) {
    rebuildAcctMap();
    import('../ui/pl-table.js').then(m => m.buildPL());
    import('../ui/settings.js').then(m => m.renderCoATree());
  }
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
