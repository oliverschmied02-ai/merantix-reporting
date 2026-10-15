import { APP } from '../state.js';
import { DEFAULT_PL_DEF, TAX_SECTION, NET_INCOME } from '../data/default-pl.js';
import { deepClone } from './utils.js';
import { rebuildAcctMap } from './resolve.js';
import { getSetting, saveSetting } from './db.js';

function persistSetting(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
  saveSetting(key, value).catch(() => {}); // best-effort, non-blocking
}

/**
 * Charts of accounts saved before the tax section existed lack it. Insert the
 * tax section (plus the after-tax result) directly below EBT, without taking
 * accounts the user has already mapped elsewhere. Mutates `def`.
 * @returns {boolean} true if `def` was changed
 */
export function ensureTaxSection(def) {
  if (!Array.isArray(def)) return false;
  if (def.some(it => it.id === TAX_SECTION.id || it.id === NET_INCOME.id)) return false;

  const mapped = new Set();
  for (const it of def) for (const s of it.subs || []) for (const a of s.accounts || []) mapped.add(a);

  const taxes = deepClone(TAX_SECTION);
  for (const s of taxes.subs) s.accounts = s.accounts.filter(a => !mapped.has(a));

  const ebtIdx = def.findIndex(it => it.id === 'ebt');
  def.splice(ebtIdx >= 0 ? ebtIdx + 1 : def.length, 0, taxes, deepClone(NET_INCOME));
  return true;
}

// Load from localStorage synchronously (instant), then sync server settings in background.
// The background sync updates APP state and re-renders if the server has newer data.
export function loadAppState() {
  try {
    const coa = localStorage.getItem('gdpdu_coa_v1');
    APP.plDef = coa ? JSON.parse(coa) : deepClone(DEFAULT_PL_DEF);
  } catch { APP.plDef = deepClone(DEFAULT_PL_DEF); }
  if (ensureTaxSection(APP.plDef)) persistSetting('gdpdu_coa_v1', APP.plDef);
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
    const migrated = ensureTaxSection(serverCoA);
    const current = JSON.stringify(APP.plDef);
    const incoming = JSON.stringify(serverCoA);
    if (current !== incoming) {
      APP.plDef = serverCoA;
      localStorage.setItem('gdpdu_coa_v1', incoming);
      changed = true;
    }
    if (migrated) saveSetting('gdpdu_coa_v1', serverCoA).catch(() => {});
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

export const KPI_DEFAULT_ORDER = ['revenue', 'ebitda', 'ebit', 'personnel', 'opex'];

export function loadKpiOrder() {
  try {
    const s = localStorage.getItem('gdpdu_kpi_order');
    if (s) {
      const saved = JSON.parse(s);
      // Reconcile a persisted order with the current KPI set: drop keys that no
      // longer exist (e.g. the removed EBT tile) and append newly added ones
      // (e.g. the sBA tile), so existing users still see the current defaults.
      const allowed = new Set(KPI_DEFAULT_ORDER);
      const merged = saved.filter(k => allowed.has(k));
      for (const k of KPI_DEFAULT_ORDER) if (!merged.includes(k)) merged.push(k);
      return merged;
    }
  } catch {}
  return [...KPI_DEFAULT_ORDER];
}

export function saveKpiOrder(order) {
  APP.kpiOrder = order;
  localStorage.setItem('gdpdu_kpi_order', JSON.stringify(order));
}
