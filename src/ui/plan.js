/**
 * Planning module UI.
 *
 * Two sub-views rendered inside #plan-screen:
 *   - Version list  (#plan-versions-view)  — shows all versions as cards
 *   - Version detail (#plan-detail-view)   — monthly grid per line item
 *
 * State is kept in module-level variables; no APP coupling needed here.
 */

import { esc, MONTH_SHORT } from '../lib/utils.js';
import {
  getPlanVersions, createPlanVersion, updatePlanVersion, lockPlanVersion, deletePlanVersion,
  getPlanLineItems, createPlanLineItem, deletePlanLineItem,
  getPlanEntries, upsertPlanEntries,
  getRevenueDrivers, createRevenueDriver, updateRevenueDriver, deleteRevenueDriver, generateFromDrivers,
} from '../lib/db.js';
import { showToast } from './screen.js';
import { aggregateByCategory, compareVersions, COMPARE_ROWS } from '../lib/plan-compare.js';

// ── Module state ──────────────────────────────────────────────────────

let _versions       = [];
let _currentVersion = null;   // full version object
let _lineItems      = [];     // line items for current version
let _entries        = [];     // plan_entries for current version (all months)
let _categoryFilter = 'all';  // 'all' | 'revenue' | 'personnel' | 'opex' | 'allocation' | 'other'
let _pendingEdits   = {};     // { `${lineItemId}_${month}`: amount }
let _saving         = false;

// Driver modal state
let _driverLineItemId = null;
let _driverEditId     = null;  // null = create, number = editing existing
let _driverList       = [];    // cached drivers for the open line item

const CATEGORIES = ['all', 'revenue', 'personnel', 'opex', 'allocation', 'other'];
const CAT_LABEL  = { all: 'Alle', revenue: 'Umsatz', personnel: 'Personal',
                     opex: 'OpEx', allocation: 'Allokation', other: 'Sonstige' };
const CAT_COLOR  = { revenue: '#16a34a', personnel: '#4f6ef7', opex: '#d97706',
                     allocation: '#7c3aed', other: '#6b7280', all: '#4f6ef7' };
const TYPE_LABEL = { budget: 'Budget', forecast: 'Forecast', scenario: 'Szenario' };
const MONTHS     = 12;

// ── Entry point ───────────────────────────────────────────────────────

export async function openPlanScreen() {
  showView('versions');
  await loadVersions();
}

// ── Version list ──────────────────────────────────────────────────────

async function loadVersions() {
  const el = document.getElementById('plan-versions-list');
  if (!el) return;
  el.innerHTML = `<div class="plan-loading">Laden…</div>`;
  try {
    _versions = await getPlanVersions();
    renderVersionList();
  } catch (e) {
    el.innerHTML = `<div class="plan-error">Fehler: ${esc(e.message)}</div>`;
  }
}

function renderVersionList() {
  const el = document.getElementById('plan-versions-list');
  if (!el) return;
  if (!_versions.length) {
    el.innerHTML = `<div class="plan-empty">Noch keine Planversionen. Erstelle deine erste Version.</div>`;
    return;
  }
  // Group by year descending
  const byYear = new Map();
  for (const v of _versions) {
    if (!byYear.has(v.year)) byYear.set(v.year, []);
    byYear.get(v.year).push(v);
  }
  const sorted = [...byYear.entries()].sort(([a], [b]) => b - a);

  el.innerHTML = sorted.map(([year, versions]) => `
    <div class="plan-year-group">
      <div class="plan-year-label">${year}</div>
      <div class="plan-version-cards">
        ${versions.map(v => versionCard(v)).join('')}
      </div>
    </div>
  `).join('');
}

function versionCard(v) {
  const locked    = !!v.locked_at;
  const typeLabel = TYPE_LABEL[v.type] ?? v.type;
  const createdAt = new Date(v.created_at).toLocaleDateString('de-DE');
  return `
    <div class="plan-version-card ${locked ? 'locked' : ''}" onclick="planOpenVersion(${v.id})">
      <div class="plan-vc-top">
        <span class="plan-vc-type">${esc(typeLabel)}</span>
        ${locked ? `<span class="plan-vc-lock" title="Gesperrt">🔒</span>` : ''}
      </div>
      <div class="plan-vc-name">${esc(v.name)}</div>
      ${v.notes ? `<div class="plan-vc-notes">${esc(v.notes)}</div>` : ''}
      <div class="plan-vc-meta">${v.year} · erstellt ${createdAt}</div>
    </div>`;
}

// ── Create version modal ──────────────────────────────────────────────

export function openCreateVersion() {
  const m = document.getElementById('plan-create-modal');
  if (!m) return;
  m.style.display = 'flex';
  document.getElementById('pcm-name').value  = '';
  document.getElementById('pcm-year').value  = new Date().getFullYear();
  document.getElementById('pcm-type').value  = 'budget';
  document.getElementById('pcm-notes').value = '';
  document.getElementById('pcm-error').textContent = '';
}

export function closeCreateVersion() {
  const m = document.getElementById('plan-create-modal');
  if (m) m.style.display = 'none';
}

export async function submitCreateVersion() {
  const name  = document.getElementById('pcm-name').value.trim();
  const year  = parseInt(document.getElementById('pcm-year').value);
  const type  = document.getElementById('pcm-type').value;
  const notes = document.getElementById('pcm-notes').value.trim();
  const errEl = document.getElementById('pcm-error');
  const btn   = document.getElementById('pcm-submit');

  errEl.textContent = '';
  if (!name) { errEl.textContent = 'Name erforderlich.'; return; }
  if (!year || year < 2020 || year > 2099) { errEl.textContent = 'Ungültiges Jahr.'; return; }

  btn.disabled = true; btn.textContent = '…';
  try {
    await createPlanVersion(name, year, type, notes || null);
    closeCreateVersion();
    showToast('Version erstellt');
    await loadVersions();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Erstellen';
  }
}

// ── Version detail ────────────────────────────────────────────────────

export async function planOpenVersion(id) {
  showView('detail');
  const loadingEl = document.getElementById('plan-detail-content');
  if (loadingEl) loadingEl.innerHTML = `<div class="plan-loading">Laden…</div>`;

  _pendingEdits = {};

  try {
    // Load version, line items, entries in parallel
    const [versionData, lineItems, entries] = await Promise.all([
      getPlanVersions().then(vs => vs.find(v => v.id === id)),
      getPlanLineItems(id, { activeOnly: false }),
      getPlanEntries(id),
    ]);

    if (!versionData) { showToast('Version nicht gefunden'); showView('versions'); return; }

    _currentVersion = versionData;
    _lineItems      = lineItems;
    _entries        = entries;
    _categoryFilter = 'all';

    renderDetailHeader();
    renderCategoryFilter();
    renderGrid();
  } catch (e) {
    if (loadingEl) loadingEl.innerHTML = `<div class="plan-error">Fehler: ${esc(e.message)}</div>`;
    showToast('Fehler: ' + e.message);
  }
}

function renderDetailHeader() {
  const v       = _currentVersion;
  const locked  = !!v.locked_at;
  const el      = document.getElementById('plan-detail-header');
  if (!el) return;
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
      <button class="plan-back-btn" onclick="planBackToList()">← Versionen</button>
      <div>
        <div class="plan-detail-title">${esc(v.name)}</div>
        <div class="plan-detail-meta">
          ${v.year} · ${TYPE_LABEL[v.type] ?? v.type}
          ${locked ? ' · <span style="color:#d97706">🔒 Gesperrt</span>' : ''}
        </div>
      </div>
      <div style="margin-left:auto;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
        ${!locked ? `<button class="btn-sm" onclick="planAddLineItem()">+ Position</button>` : ''}
        ${!locked ? `<button class="btn-plan-save hidden" id="plan-save-btn" onclick="planSaveEdits()">Speichern</button>` : ''}
        ${!locked
          ? `<button class="btn-sm" onclick="planLockVersion(${v.id})">🔒 Sperren</button>`
          : `<button class="btn-sm" onclick="planLockVersion(${v.id})">🔓 Entsperren</button>`
        }
        <button class="btn-sm" style="color:#dc2626;border-color:#fecaca" onclick="planDeleteVersion(${v.id})">Löschen</button>
      </div>
    </div>`;
}

function renderCategoryFilter() {
  const el = document.getElementById('plan-category-filter');
  if (!el) return;
  el.innerHTML = CATEGORIES.map(cat => `
    <button class="seg-btn ${_categoryFilter === cat ? 'active' : ''}"
            onclick="planSetCategory('${cat}')">
      ${CAT_LABEL[cat]}
    </button>`).join('');
}

function renderGrid() {
  const el = document.getElementById('plan-detail-content');
  if (!el) return;

  const items = _categoryFilter === 'all'
    ? _lineItems
    : _lineItems.filter(li => li.category === _categoryFilter);

  if (!items.length) {
    el.innerHTML = `<div class="plan-empty">
      Keine Positionen ${_categoryFilter !== 'all' ? 'in dieser Kategorie' : ''}.
      ${!_currentVersion.locked_at ? `<a href="#" onclick="planAddLineItem();return false">Position hinzufügen</a>.` : ''}
    </div>`;
    return;
  }

  // Build a lookup: lineItemId → { month → amount }
  const entryMap = new Map();
  for (const e of _entries) {
    if (!entryMap.has(e.line_item_id)) entryMap.set(e.line_item_id, {});
    entryMap.get(e.line_item_id)[e.month] = Number(e.amount);
  }

  const locked   = !!_currentVersion.locked_at;
  const year     = _currentVersion.year;

  el.innerHTML = `
    <div class="plan-grid-wrap">
      <table class="plan-grid">
        <thead>
          <tr>
            <th class="pg-pos">Position</th>
            <th class="pg-cat">Kategorie</th>
            ${MONTH_SHORT.map((m, i) => `<th class="pg-month">${m}</th>`).join('')}
            <th class="pg-total">Gesamt</th>
            ${!locked ? '<th class="pg-actions"></th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${items.map(li => gridRow(li, entryMap.get(li.id) || {}, locked)).join('')}
        </tbody>
        <tfoot>
          ${gridTotalRow(items, entryMap, locked)}
        </tfoot>
      </table>
    </div>`;
}

function gridRow(li, monthAmounts, locked) {
  const cat   = li.category;
  const color = CAT_COLOR[cat] || '#6b7280';

  let rowTotal = 0;
  const cells = [];

  for (let m = 1; m <= MONTHS; m++) {
    const pending = _pendingEdits[`${li.id}_${m}`];
    const val     = pending !== undefined ? pending : (monthAmounts[m] ?? 0);
    rowTotal += val;
    const isDirty = pending !== undefined;

    if (locked) {
      cells.push(`<td class="pg-cell">${val !== 0 ? `<span class="pg-val">${fmtCell(val)}</span>` : '<span class="pg-zero">—</span>'}</td>`);
    } else {
      cells.push(`
        <td class="pg-cell pg-editable ${isDirty ? 'pg-dirty' : ''}">
          <input type="text"
                 class="pg-input"
                 value="${val !== 0 ? formatInputVal(val) : ''}"
                 placeholder="—"
                 data-li="${li.id}"
                 data-month="${m}"
                 onblur="planCellBlur(this)"
                 onkeydown="planCellKeydown(event,this)"
                 onfocus="this.select()"
          />
        </td>`);
    }
  }

  return `
    <tr class="pg-row" id="pgrow-${li.id}">
      <td class="pg-pos-cell">
        <span class="pg-li-label">${esc(li.label)}</span>
        ${li.entity ? `<span class="pg-li-tag">${esc(li.entity)}</span>` : ''}
        ${li.fund_ref ? `<span class="pg-li-tag pg-li-fund">${esc(li.fund_ref)}</span>` : ''}
      </td>
      <td class="pg-cat-cell">
        <span class="pg-cat-badge" style="background:${color}20;color:${color}">${CAT_LABEL[cat] ?? cat}</span>
      </td>
      ${cells.join('')}
      <td class="pg-total-cell">${fmtCell(rowTotal)}</td>
      ${!locked ? `<td class="pg-actions-cell">
        ${cat === 'revenue' ? `<button class="pg-driver-btn" onclick="openDriverModal(${li.id})" title="Revenue Drivers">⚙</button>` : ''}
        <button class="pg-del-btn" onclick="planDeleteLineItem(${li.id})" title="Position löschen">✕</button>
      </td>` : ''}
    </tr>`;
}

function gridTotalRow(items, entryMap, locked) {
  const colTotals = new Array(MONTHS).fill(0);
  let grandTotal = 0;
  for (const li of items) {
    const monthAmounts = entryMap.get(li.id) || {};
    for (let m = 1; m <= MONTHS; m++) {
      const pending = _pendingEdits[`${li.id}_${m}`];
      const val = pending !== undefined ? pending : (monthAmounts[m] ?? 0);
      colTotals[m - 1] += val;
      grandTotal += val;
    }
  }
  return `
    <tr class="pg-total-row">
      <td class="pg-pos-cell" style="font-weight:700">Summe</td>
      <td></td>
      ${colTotals.map(v => `<td class="pg-cell"><span class="pg-total-val">${fmtCell(v)}</span></td>`).join('')}
      <td class="pg-total-cell pg-grand">${fmtCell(grandTotal)}</td>
      ${!locked ? '<td></td>' : ''}
    </tr>`;
}

// ── Cell editing ──────────────────────────────────────────────────────

export function planCellBlur(input) {
  commitCell(input);
}

export function planCellKeydown(e, input) {
  if (e.key === 'Enter') {
    e.preventDefault();
    input.blur();
    // Move to next month in same row
    const m = parseInt(input.dataset.month);
    if (m < 12) {
      const next = document.querySelector(`input[data-li="${input.dataset.li}"][data-month="${m + 1}"]`);
      if (next) next.focus();
    }
  }
  if (e.key === 'Tab') {
    commitCell(input);
    // default Tab behaviour moves focus naturally
  }
  if (e.key === 'Escape') {
    const liId  = parseInt(input.dataset.li);
    const month = parseInt(input.dataset.month);
    const key   = `${liId}_${month}`;
    delete _pendingEdits[key];
    // Restore original value
    const li         = _lineItems.find(l => l.id === liId);
    const entryMap   = buildEntryMap();
    const orig       = (entryMap.get(liId) || {})[month] ?? 0;
    input.value      = orig !== 0 ? formatInputVal(orig) : '';
    input.closest('td').classList.remove('pg-dirty');
    updateSaveButton();
    input.blur();
  }
}

function commitCell(input) {
  const liId  = parseInt(input.dataset.li);
  const month = parseInt(input.dataset.month);
  const raw   = input.value.trim().replace(',', '.');
  const val   = raw === '' ? 0 : parseFloat(raw);

  if (isNaN(val)) {
    // Reset to existing
    const orig = (buildEntryMap().get(liId) || {})[month] ?? 0;
    input.value = orig !== 0 ? formatInputVal(orig) : '';
    return;
  }

  const key = `${liId}_${month}`;
  // Only dirty if different from persisted value
  const persisted = (buildEntryMap().get(liId) || {})[month] ?? 0;
  if (Math.abs(val - persisted) < 0.001) {
    delete _pendingEdits[key];
  } else {
    _pendingEdits[key] = val;
  }

  input.value = val !== 0 ? formatInputVal(val) : '';
  input.closest('td').classList.toggle('pg-dirty', _pendingEdits[key] !== undefined);

  // Update row total and column total inline
  updateRowTotal(liId);
  updateColTotal(month);
  updateGrandTotal();
  updateSaveButton();
}

function updateRowTotal(liId) {
  const entryMap = buildEntryMap();
  let rowTotal = 0;
  for (let m = 1; m <= MONTHS; m++) {
    const pending = _pendingEdits[`${liId}_${m}`];
    rowTotal += pending !== undefined ? pending : ((entryMap.get(liId) || {})[m] ?? 0);
  }
  const cell = document.querySelector(`#pgrow-${liId} .pg-total-cell`);
  if (cell) cell.textContent = fmtCell(rowTotal);
}

function updateColTotal(month) {
  const entryMap = buildEntryMap();
  const items = _categoryFilter === 'all' ? _lineItems : _lineItems.filter(li => li.category === _categoryFilter);
  let colTotal = 0;
  for (const li of items) {
    const pending = _pendingEdits[`${li.id}_${month}`];
    colTotal += pending !== undefined ? pending : ((entryMap.get(li.id) || {})[month] ?? 0);
  }
  const cells = document.querySelectorAll(`.pg-total-row .pg-cell`);
  if (cells[month - 1]) cells[month - 1].querySelector('.pg-total-val').textContent = fmtCell(colTotal);
}

function updateGrandTotal() {
  const entryMap = buildEntryMap();
  const items = _categoryFilter === 'all' ? _lineItems : _lineItems.filter(li => li.category === _categoryFilter);
  let grand = 0;
  for (const li of items) {
    for (let m = 1; m <= MONTHS; m++) {
      const pending = _pendingEdits[`${li.id}_${m}`];
      grand += pending !== undefined ? pending : ((entryMap.get(li.id) || {})[m] ?? 0);
    }
  }
  const el = document.querySelector('.pg-grand');
  if (el) el.textContent = fmtCell(grand);
}

function updateSaveButton() {
  const btn = document.getElementById('plan-save-btn');
  if (!btn) return;
  const hasPending = Object.keys(_pendingEdits).length > 0;
  btn.classList.toggle('hidden', !hasPending);
}

// ── Save edits ────────────────────────────────────────────────────────

export async function planSaveEdits() {
  if (_saving || !Object.keys(_pendingEdits).length) return;
  _saving = true;
  const btn = document.getElementById('plan-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  try {
    // Group pending edits by line item
    const byLineItem = {};
    for (const [key, amount] of Object.entries(_pendingEdits)) {
      const [liId, month] = key.split('_').map(Number);
      if (!byLineItem[liId]) byLineItem[liId] = [];
      const li = _lineItems.find(l => l.id === liId);
      if (li) byLineItem[liId].push({ month, year: _currentVersion.year, amount, item_id: li.item_id });
    }

    // Upsert each line item's entries
    const promises = Object.entries(byLineItem).map(([liId, entries]) =>
      upsertPlanEntries(_currentVersion.id, entries.map(e => ({ ...e, line_item_id: parseInt(liId) })))
    );
    await Promise.all(promises);

    // Merge saved edits into _entries
    for (const [key, amount] of Object.entries(_pendingEdits)) {
      const [liId, month] = key.split('_').map(Number);
      const existing = _entries.find(e => e.line_item_id === liId && e.month === month);
      if (existing) {
        existing.amount = amount;
      } else {
        const li = _lineItems.find(l => l.id === liId);
        _entries.push({ line_item_id: liId, month, year: _currentVersion.year, amount, item_id: li?.item_id });
      }
    }

    _pendingEdits = {};
    updateSaveButton();
    // Clear dirty flags
    document.querySelectorAll('.pg-dirty').forEach(el => el.classList.remove('pg-dirty'));
    showToast('Gespeichert');
  } catch (e) {
    showToast('Fehler beim Speichern: ' + e.message);
  } finally {
    _saving = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Speichern'; }
  }
}

// ── Add line item ─────────────────────────────────────────────────────

export function planAddLineItem() {
  const m = document.getElementById('plan-lineitem-modal');
  if (!m) return;
  m.style.display = 'flex';
  document.getElementById('plm-label').value    = '';
  document.getElementById('plm-category').value = 'opex';
  document.getElementById('plm-entity').value   = '';
  document.getElementById('plm-fund').value     = '';
  document.getElementById('plm-itemid').value   = 'opex';
  document.getElementById('plm-error').textContent = '';
}

export function closeLineItemModal() {
  const m = document.getElementById('plan-lineitem-modal');
  if (m) m.style.display = 'none';
}

export async function submitAddLineItem() {
  const label    = document.getElementById('plm-label').value.trim();
  const category = document.getElementById('plm-category').value;
  const entity   = document.getElementById('plm-entity').value.trim();
  const fund_ref = document.getElementById('plm-fund').value.trim();
  const item_id  = document.getElementById('plm-itemid').value.trim() || category;
  const errEl    = document.getElementById('plm-error');
  const btn      = document.getElementById('plm-submit');

  errEl.textContent = '';
  if (!label) { errEl.textContent = 'Bezeichnung erforderlich.'; return; }

  btn.disabled = true; btn.textContent = '…';
  try {
    const li = await createPlanLineItem(_currentVersion.id, {
      label, category, entity: entity || null, fund_ref: fund_ref || null,
      item_id, sort_order: _lineItems.length,
    });
    _lineItems.push(li);
    closeLineItemModal();
    renderGrid();
    showToast('Position hinzugefügt');
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Hinzufügen';
  }
}

// ── Delete line item ──────────────────────────────────────────────────

export async function planDeleteLineItem(id) {
  if (!confirm('Position löschen? Alle Planwerte gehen verloren.')) return;
  try {
    await deletePlanLineItem(_currentVersion.id, id);
    _lineItems = _lineItems.filter(li => li.id !== id);
    _entries   = _entries.filter(e => e.line_item_id !== id);
    // Remove pending edits for this line item
    for (const key of Object.keys(_pendingEdits)) {
      if (key.startsWith(`${id}_`)) delete _pendingEdits[key];
    }
    renderGrid();
    showToast('Position gelöscht');
  } catch (e) {
    showToast('Fehler: ' + e.message);
  }
}

// ── Category filter ───────────────────────────────────────────────────

export function planSetCategory(cat) {
  if (Object.keys(_pendingEdits).length > 0) {
    if (!confirm('Ungespeicherte Änderungen verwerfen?')) return;
    _pendingEdits = {};
  }
  _categoryFilter = cat;
  renderCategoryFilter();
  renderGrid();
}

// ── Lock / unlock version ─────────────────────────────────────────────

export async function planLockVersion(id) {
  const locked = !!_currentVersion.locked_at;
  const msg    = locked ? 'Version entsperren?' : 'Version sperren? Danach sind keine Änderungen mehr möglich.';
  if (!confirm(msg)) return;
  try {
    const updated = await lockPlanVersion(id, !locked);
    _currentVersion = { ..._currentVersion, ...updated };
    renderDetailHeader();
    renderGrid();
    showToast(locked ? 'Entsperrt' : 'Gesperrt');
  } catch (e) {
    showToast('Fehler: ' + e.message);
  }
}

// ── Delete version ────────────────────────────────────────────────────

export async function planDeleteVersion(id) {
  if (!confirm('Version dauerhaft löschen? Alle Daten gehen verloren.')) return;
  try {
    await (await import('../lib/db.js')).deletePlanVersion(id);
    showToast('Version gelöscht');
    planBackToList();
    await loadVersions();
  } catch (e) {
    showToast('Fehler: ' + e.message);
  }
}

// ── Navigation ────────────────────────────────────────────────────────

export function planBackToList() {
  if (Object.keys(_pendingEdits).length > 0) {
    if (!confirm('Ungespeicherte Änderungen verwerfen?')) return;
    _pendingEdits = {};
  }
  _currentVersion = null;
  _lineItems = [];
  _entries   = [];
  showView('versions');
}

// ── Helpers ───────────────────────────────────────────────────────────

function showView(name) {
  document.getElementById('plan-versions-view').style.display = name === 'versions' ? 'block' : 'none';
  document.getElementById('plan-detail-view').style.display   = name === 'detail'   ? 'flex'  : 'none';
  document.getElementById('plan-compare-view').style.display  = name === 'compare'  ? 'flex'  : 'none';
}

// ── Scenario Comparison ───────────────────────────────────────────────

let _cmpVersions  = [];   // all available versions (same year)
let _cmpIdA       = null;
let _cmpIdB       = null;

export async function openCompareScreen() {
  showView('compare');
  const el = document.getElementById('plan-compare-content');
  if (el) el.innerHTML = `<div class="plan-loading">Laden…</div>`;

  try {
    _cmpVersions = await getPlanVersions();
    renderCompareSelectors();
    if (el) el.innerHTML = `<div class="plan-empty">Wähle zwei Versionen zum Vergleich.</div>`;
  } catch (e) {
    if (el) el.innerHTML = `<div class="plan-error">Fehler: ${esc(e.message)}</div>`;
  }
}

function renderCompareSelectors() {
  const selA = document.getElementById('cmp-sel-a');
  const selB = document.getElementById('cmp-sel-b');
  if (!selA || !selB) return;

  const opts = _cmpVersions
    .sort((a, b) => b.year - a.year || a.name.localeCompare(b.name))
    .map(v => `<option value="${v.id}">${esc(v.year + ' · ' + v.name)}</option>`)
    .join('');

  selA.innerHTML = `<option value="">— Version A —</option>${opts}`;
  selB.innerHTML = `<option value="">— Version B —</option>${opts}`;

  // Restore previous selection if still valid
  if (_cmpIdA) selA.value = _cmpIdA;
  if (_cmpIdB) selB.value = _cmpIdB;
}

export async function runComparison() {
  const selA = document.getElementById('cmp-sel-a');
  const selB = document.getElementById('cmp-sel-b');
  _cmpIdA = parseInt(selA?.value) || null;
  _cmpIdB = parseInt(selB?.value) || null;

  const el = document.getElementById('plan-compare-content');
  if (!_cmpIdA || !_cmpIdB) {
    if (el) el.innerHTML = `<div class="plan-empty">Bitte zwei Versionen auswählen.</div>`;
    return;
  }
  if (_cmpIdA === _cmpIdB) {
    if (el) el.innerHTML = `<div class="plan-empty" style="color:#d97706">Bitte zwei verschiedene Versionen auswählen.</div>`;
    return;
  }

  if (el) el.innerHTML = `<div class="plan-loading">Berechne…</div>`;

  try {
    // Load both versions in parallel
    const [[liA, liB], [entA, entB]] = await Promise.all([
      Promise.all([
        getPlanLineItems(_cmpIdA, { activeOnly: false }),
        getPlanLineItems(_cmpIdB, { activeOnly: false }),
      ]),
      Promise.all([
        getPlanEntries(_cmpIdA),
        getPlanEntries(_cmpIdB),
      ]),
    ]);

    const vA = _cmpVersions.find(v => v.id === _cmpIdA);
    const vB = _cmpVersions.find(v => v.id === _cmpIdB);

    const monthlyA = aggregateByCategory(liA, entA);
    const monthlyB = aggregateByCategory(liB, entB);
    const rows     = compareVersions(monthlyA, monthlyB);

    if (el) el.innerHTML = renderCompareTable(rows, vA, vB);
  } catch (e) {
    if (el) el.innerHTML = `<div class="plan-error">Fehler: ${esc(e.message)}</div>`;
    showToast('Fehler beim Vergleich: ' + e.message);
  }
}

function renderCompareTable(rows, vA, vB) {
  const nameA = esc(vA ? `${vA.year} ${vA.name}` : 'Version A');
  const nameB = esc(vB ? `${vB.year} ${vB.name}` : 'Version B');

  const monthHeaders = MONTH_SHORT.map(m =>
    `<th colspan="2" class="cmp-month-head">${m}</th>`
  ).join('');

  const monthSubHeaders = MONTH_SHORT.map(() =>
    `<th class="cmp-sub-head cmp-a">A</th><th class="cmp-sub-head cmp-b">B</th>`
  ).join('');

  const bodyRows = rows.map(row => {
    const isEbitda  = row.computed;
    const rowClass  = isEbitda ? 'cmp-row cmp-row-ebitda' : 'cmp-row';

    const monthlyCells = Array.from({ length: 12 }, (_, i) => {
      const m    = i + 1;
      const cell = row.monthly[m];
      return `
        <td class="cmp-cell cmp-a">${fmtCmp(cell.a)}</td>
        <td class="cmp-cell cmp-b">${fmtCmp(cell.b)}</td>`;
    }).join('');

    const ann   = row.annual;
    const dSign = ann.delta > 0 ? 'pos' : ann.delta < 0 ? 'neg' : 'zero';
    const pSign = ann.pct !== null
      ? (ann.pct > 0 ? 'pos' : ann.pct < 0 ? 'neg' : 'zero')
      : 'zero';
    const pctTxt = ann.pct !== null
      ? `${ann.pct > 0 ? '+' : ''}${ann.pct.toFixed(1)}%`
      : '—';

    return `
      <tr class="${rowClass}">
        <td class="cmp-label">${esc(row.label)}</td>
        ${monthlyCells}
        <td class="cmp-annual cmp-a">${fmtCmp(ann.a)}</td>
        <td class="cmp-annual cmp-b">${fmtCmp(ann.b)}</td>
        <td class="cmp-delta cmp-delta-${dSign}">${fmtDelta(ann.delta)}</td>
        <td class="cmp-pct cmp-delta-${pSign}">${pctTxt}</td>
      </tr>`;
  }).join('');

  // Monthly delta summary rows (one row = all months, showing B-A delta)
  const deltaRows = rows.map(row => {
    const isEbitda = row.computed;
    const cells = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const d = row.monthly[m].delta;
      const cls = d > 0 ? 'pos' : d < 0 ? 'neg' : 'zero';
      return `<td colspan="2" class="cmp-mdelta cmp-delta-${cls}">${fmtDelta(d)}</td>`;
    }).join('');

    const ann = row.annual;
    const dSign = ann.delta > 0 ? 'pos' : ann.delta < 0 ? 'neg' : 'zero';

    return `
      <tr class="${isEbitda ? 'cmp-row-ebitda-delta' : 'cmp-delta-row'}">
        <td class="cmp-label cmp-delta-label">Δ ${esc(row.label)}</td>
        ${cells}
        <td colspan="2" class="cmp-annual cmp-delta-${dSign}">${fmtDelta(ann.delta)}</td>
        <td class="cmp-delta cmp-delta-${dSign}">${fmtDelta(ann.delta)}</td>
        <td class="cmp-pct cmp-delta-${dSign}">
          ${ann.pct !== null ? `${ann.pct > 0 ? '+' : ''}${ann.pct.toFixed(1)}%` : '—'}
        </td>
      </tr>`;
  }).join('');

  return `
    <div class="cmp-wrap">
      <div class="cmp-legend">
        <span class="cmp-legend-a">A: ${nameA}</span>
        <span class="cmp-legend-sep">vs.</span>
        <span class="cmp-legend-b">B: ${nameB}</span>
        <span class="cmp-legend-note">Δ = B − A · positive = B höher</span>
      </div>
      <div class="cmp-table-scroll">
        <table class="cmp-table">
          <thead>
            <tr>
              <th class="cmp-label-head" rowspan="2">Position</th>
              ${monthHeaders}
              <th colspan="2" class="cmp-annual-head">Gesamt</th>
              <th class="cmp-delta-head" rowspan="2">Δ Abs.</th>
              <th class="cmp-pct-head" rowspan="2">Δ %</th>
            </tr>
            <tr>
              ${monthSubHeaders}
              <th class="cmp-sub-head cmp-a">A</th>
              <th class="cmp-sub-head cmp-b">B</th>
            </tr>
          </thead>
          <tbody>
            ${bodyRows}
            <tr class="cmp-spacer-row"><td colspan="100"></td></tr>
            ${deltaRows}
          </tbody>
        </table>
      </div>
    </div>`;
}

function fmtCmp(v) {
  if (v === 0) return '<span class="cmp-zero">—</span>';
  const n = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.abs(v));
  return v < 0 ? `<span style="color:#dc2626">(${n})</span>` : n;
}

function fmtDelta(v) {
  if (v === 0) return '<span class="cmp-zero">—</span>';
  const abs = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.abs(v));
  return v > 0 ? `+${abs}` : `−${abs}`;
}

function buildEntryMap() {
  const m = new Map();
  for (const e of _entries) {
    if (!m.has(e.line_item_id)) m.set(e.line_item_id, {});
    m.get(e.line_item_id)[e.month] = Number(e.amount);
  }
  return m;
}

function fmtCell(v) {
  if (v === 0) return '—';
  return new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);
}

function formatInputVal(v) {
  // Show as plain number for editing, no thousand separators
  return Number(v).toFixed(2).replace(/\.00$/, '').replace('.', ',');
}

// ── Revenue driver modal ──────────────────────────────────────────────

const DRIVER_TYPE_LABEL = {
  management_fee: 'Management Fee',
  annual_fee:     'Jahresbetrag',
  monthly_flat:   'Monatlicher Fixbetrag',
  one_off:        'Einmalzahlung',
};

const FMT_EUR = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

export async function openDriverModal(lineItemId) {
  _driverLineItemId = lineItemId;
  _driverEditId = null;

  const li = _lineItems.find(l => l.id === lineItemId);
  document.getElementById('pdm-title').textContent =
    `Revenue Drivers — ${li ? esc(li.label) : lineItemId}`;

  try {
    _driverList = await getRevenueDrivers(lineItemId);
  } catch (e) {
    _driverList = [];
  }

  _resetDriverForm();
  _renderDriverList();

  const m = document.getElementById('plan-driver-modal');
  m.style.display = 'flex';
}

export function closeDriverModal() {
  document.getElementById('plan-driver-modal').style.display = 'none';
  _driverLineItemId = null;
  _driverEditId = null;
}

export function driverTypeChanged() {
  const type = document.getElementById('pdm-type').value;
  document.getElementById('pdm-mgmt-fields').style.display  = type === 'management_fee' ? 'grid' : 'none';
  document.getElementById('pdm-amount-field').style.display = type === 'management_fee' ? 'none' : 'block';
  _updateDriverPreview();
}

export function driverPreviewUpdate() {
  _updateDriverPreview();
}

function _updateDriverPreview() {
  const preview = document.getElementById('pdm-preview');
  if (!preview) return;
  const type = document.getElementById('pdm-type').value;
  if (type === 'management_fee') {
    const c   = parseFloat(document.getElementById('pdm-commitment').value) || 0;
    const pct = parseFloat(document.getElementById('pdm-fee-pct').value)    || 0;
    const annual = c * pct / 100;
    preview.textContent = annual > 0
      ? `→ ${FMT_EUR.format(annual)} p.a. · ${FMT_EUR.format(annual / 12)} / Monat`
      : '';
  } else {
    preview.textContent = '';
  }
}

export async function submitDriver() {
  const type  = document.getElementById('pdm-type').value;
  const start = document.getElementById('pdm-start').value || null;
  const end   = document.getElementById('pdm-end').value   || null;
  const notes = document.getElementById('pdm-notes').value.trim() || null;
  const errEl = document.getElementById('pdm-error');
  errEl.textContent = '';

  let payload = { driver_type: type, start_date: start, end_date: end, notes };

  if (type === 'management_fee') {
    const commitment = parseFloat(document.getElementById('pdm-commitment').value);
    const fee_pct    = parseFloat(document.getElementById('pdm-fee-pct').value);
    if (!commitment || !fee_pct) { errEl.textContent = 'Bitte Commitment und Fee % angeben.'; return; }
    payload = { ...payload, commitment, fee_pct };
  } else {
    const rawAmt = document.getElementById('pdm-amount').value.replace(',', '.');
    const amount = parseFloat(rawAmt);
    if (isNaN(amount)) { errEl.textContent = 'Bitte Betrag angeben.'; return; }
    payload = { ...payload, amount };
  }

  const btn = document.getElementById('pdm-submit');
  btn.disabled = true;
  try {
    if (_driverEditId) {
      await updateRevenueDriver(_driverLineItemId, _driverEditId, payload);
    } else {
      await createRevenueDriver(_driverLineItemId, payload);
    }
    _driverList = await getRevenueDrivers(_driverLineItemId);
    _resetDriverForm();
    _renderDriverList();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

export async function driverGenerate() {
  if (!_driverLineItemId) return;
  const btn = document.getElementById('pdm-gen-btn');
  if (btn) btn.disabled = true;
  try {
    const result = await generateFromDrivers(_driverLineItemId);
    // Reload entries so the grid reflects generated amounts
    _entries = await (await import('../lib/db.js')).getPlanEntries(_currentVersion.id);
    renderGrid();
    showToast(`${result.entries?.length ?? 0} Einträge generiert.`);
    closeDriverModal();
  } catch (e) {
    showToast('Fehler: ' + e.message);
    if (btn) btn.disabled = false;
  }
}

export async function driverDelete(driverId) {
  if (!confirm('Driver löschen?')) return;
  try {
    await deleteRevenueDriver(_driverLineItemId, driverId);
    _driverList = _driverList.filter(d => d.id !== driverId);
    _renderDriverList();
  } catch (e) {
    showToast('Fehler: ' + e.message);
  }
}

export function driverEdit(driverId) {
  const d = _driverList.find(x => x.id === driverId);
  if (!d) return;
  _driverEditId = driverId;

  document.getElementById('pdm-type').value = d.driver_type;
  driverTypeChanged();

  if (d.driver_type === 'management_fee') {
    document.getElementById('pdm-commitment').value = d.commitment ?? '';
    document.getElementById('pdm-fee-pct').value    = d.fee_pct    ?? '';
    _updateDriverPreview();
  } else {
    document.getElementById('pdm-amount').value = d.amount ?? '';
  }
  document.getElementById('pdm-start').value = d.start_date ? d.start_date.slice(0, 10) : '';
  document.getElementById('pdm-end').value   = d.end_date   ? d.end_date.slice(0, 10)   : '';
  document.getElementById('pdm-notes').value = d.notes ?? '';
  document.getElementById('pdm-submit').textContent = 'Aktualisieren';
  document.getElementById('pdm-error').textContent  = '';
}

function _resetDriverForm() {
  document.getElementById('pdm-type').value       = 'management_fee';
  document.getElementById('pdm-commitment').value = '';
  document.getElementById('pdm-fee-pct').value    = '';
  document.getElementById('pdm-amount').value     = '';
  document.getElementById('pdm-start').value      = '';
  document.getElementById('pdm-end').value        = '';
  document.getElementById('pdm-notes').value      = '';
  document.getElementById('pdm-preview').textContent = '';
  document.getElementById('pdm-error').textContent   = '';
  document.getElementById('pdm-submit').textContent  = 'Speichern';
  document.getElementById('pdm-mgmt-fields').style.display  = 'grid';
  document.getElementById('pdm-amount-field').style.display = 'none';
  _driverEditId = null;
}

function _renderDriverList() {
  // Render existing drivers above the form inside the modal body
  let existing = document.getElementById('pdm-existing-list');
  if (!existing) {
    existing = document.createElement('div');
    existing.id = 'pdm-existing-list';
    existing.style.cssText = 'margin-bottom:.75rem';
    const body = document.querySelector('#plan-driver-modal .plan-modal-body');
    body.insertBefore(existing, body.firstChild);
  }

  // Generate button
  const hasDrivers = _driverList.length > 0;
  const genBtn = hasDrivers
    ? `<button id="pdm-gen-btn" class="btn-plan-primary" style="font-size:.75rem;padding:.3rem .75rem" onclick="driverGenerate()">
         ▶ Einträge generieren
       </button>`
    : '';

  if (!_driverList.length) {
    existing.innerHTML = `<div style="font-size:.78rem;color:#a0aabb;margin-bottom:.5rem">Noch keine Drivers definiert.</div>`;
    return;
  }

  existing.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.4rem">
      <div style="font-size:.72rem;font-weight:700;color:#6b7a99;text-transform:uppercase;letter-spacing:.04em">Bestehende Drivers</div>
      ${genBtn}
    </div>
    <table style="width:100%;font-size:.76rem;border-collapse:collapse">
      <thead>
        <tr style="color:#a0aabb;font-weight:600">
          <th style="text-align:left;padding:.2rem .4rem">Typ</th>
          <th style="text-align:right;padding:.2rem .4rem">p.a.</th>
          <th style="text-align:right;padding:.2rem .4rem">/ Monat</th>
          <th style="padding:.2rem .4rem"></th>
        </tr>
      </thead>
      <tbody>
        ${_driverList.map(d => {
          const annualAmt = Number(d.amount);
          const label = d.driver_type === 'management_fee'
            ? `${FMT_EUR.format(d.commitment)} × ${d.fee_pct}%`
            : DRIVER_TYPE_LABEL[d.driver_type] ?? d.driver_type;
          return `
            <tr style="border-top:1px solid #f0f2f8">
              <td style="padding:.3rem .4rem;color:#1e2433;font-weight:600">${label}${d.notes ? `<br><span style="color:#a0aabb;font-weight:400">${esc(d.notes)}</span>` : ''}</td>
              <td style="padding:.3rem .4rem;text-align:right;color:#4f6ef7;font-weight:700">${FMT_EUR.format(annualAmt)}</td>
              <td style="padding:.3rem .4rem;text-align:right;color:#6b7a99">${FMT_EUR.format(annualAmt / 12)}</td>
              <td style="padding:.3rem .4rem;text-align:right;white-space:nowrap">
                <button class="btn-sm" style="font-size:.68rem;padding:.15rem .4rem" onclick="driverEdit(${d.id})">✎</button>
                <button class="btn-sm" style="font-size:.68rem;padding:.15rem .4rem;color:#dc2626;border-color:#fecaca" onclick="driverDelete(${d.id})">✕</button>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
    <div style="margin:.5rem 0;border-top:2px solid #e4e9f5"></div>`;
}
