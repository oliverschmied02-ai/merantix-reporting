import { APP } from '../state.js';
import { esc, fmtFull } from '../lib/utils.js';
import { resolveMapping } from '../lib/resolve.js';
import { isInGUV } from '../lib/compute.js';
import { saveRules } from '../lib/storage.js';
import { buildPL } from './pl-table.js';
import { showToast } from './screen.js';

export function initTransactionPicker() {
  const subs = APP.plDef.flatMap(i => i.subs ? i.subs.map(s => ({ ...s, itemLabel: i.label, itemId: i.id })) : []);
  const select = document.getElementById('txn-bulk-target-sub');
  select.innerHTML = `<option value="">-- Kategorie wählen --</option>${subs.map(s =>
    `<option value="${s.itemId}|${s.id}">${esc(s.itemLabel)} → ${esc(s.label)}</option>`
  ).join('')}`;
  updateTransactionPicker();
}

export function updateTransactionPicker() {
  const query   = document.getElementById('txn-picker-search').value.toLowerCase().trim();
  const guvOnly = document.getElementById('txn-filter-guv')?.checked;
  let indexedAll = APP.allTransactions.map((t, i) => ({ t, i }));

  if (guvOnly) {
    indexedAll = indexedAll.filter(({ t }) => isInGUV(t.ktonr));
  }

  if (query) {
    indexedAll = indexedAll.filter(({ t }) =>
      t.text?.toLowerCase().includes(query) ||
      t.beleg?.toLowerCase().includes(query) ||
      String(t.ktonr).includes(query) ||
      String(t.gktonr || '').includes(query) ||
      t.stapelRaw?.toLowerCase().includes(query)
    );
  }

  const MAX = 500;
  const truncated = indexedAll.length > MAX;
  const visible = indexedAll.slice(0, MAX);

  document.getElementById('txn-picker-count').textContent =
    `${indexedAll.length.toLocaleString('de-DE')} von ${APP.allTransactions.length.toLocaleString('de-DE')} Buchungen` +
    (truncated ? ` (nur erste ${MAX} angezeigt — Suche verfeinern)` : '');

  const tbody = document.getElementById('txn-picker-tbody');

  if (!APP.allTransactions.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="padding:1.5rem;text-align:center;color:#a0aabb;font-size:.78rem">Keine Datei geladen.</td></tr>`;
    return;
  }
  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="padding:1.5rem;text-align:center;color:#a0aabb;font-size:.78rem">Keine Buchungen gefunden.</td></tr>`;
    return;
  }

  tbody.innerHTML = visible.map(({ t, i }) => {
    const mapping = resolveMapping(t);
    const currentCat = mapping
      ? (APP.plDef.find(x => x.id === mapping.itemId)?.label || '?') +
        ' / ' +
        (APP.plDef.find(x => x.id === mapping.itemId)?.subs?.find(s => s.id === mapping.subId)?.label || '?')
      : '—';
    const d = t.datum
      ? t.datum.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '—';
    const isSelected = APP.selectedTransactions.has(i);
    const soll  = t.soll  ? fmtFull(t.soll)  : '—';
    const haben = t.haben ? fmtFull(t.haben) : '—';

    return `<tr style="border-bottom:1px solid #f0f2f8" onmouseover="this.style.background='#f8f9fd'" onmouseout="this.style.background=''">
      <td style="padding:.3rem;text-align:center"><input type="checkbox" data-txn-idx="${i}" ${isSelected ? 'checked' : ''} onchange="toggleTransactionSelection(${i})"></td>
      <td style="padding:.3rem;color:#8b95a9;font-size:.68rem">${d}</td>
      <td style="padding:.3rem;max-width:60px;overflow:hidden;text-overflow:ellipsis;color:#a0aabb;font-size:.68rem">${esc(t.beleg || '—')}</td>
      <td style="padding:.3rem;color:#4f6ef7;font-weight:600">${t.ktonr}</td>
      <td style="padding:.3rem;color:#c4cde0;font-size:.67rem">${t.gktonr || '—'}</td>
      <td style="padding:.3rem;max-width:100px;overflow:hidden;text-overflow:ellipsis;color:#4b5563">${esc((t.text||'').slice(0, 40))}</td>
      <td style="padding:.3rem;text-align:right;color:#dc2626;font-weight:600">${soll}</td>
      <td style="padding:.3rem;text-align:right;color:#16a34a;font-weight:600">${haben}</td>
      <td style="padding:.3rem;font-size:.65rem;max-width:80px;overflow:hidden;text-overflow:ellipsis;color:#8b95a9">${esc(String(currentCat).slice(0, 28))}</td>
    </tr>`;
  }).join('');

  const allCheckboxes = document.querySelectorAll('[data-txn-idx]');
  const selectAllCheckbox = document.getElementById('txn-select-all');
  if (allCheckboxes.length > 0) {
    selectAllCheckbox.checked = [...allCheckboxes].every(cb => cb.checked);
  }

  updateTransactionSelectionPanel();
}

export function toggleTransactionSelection(idx) {
  if (APP.selectedTransactions.has(idx)) APP.selectedTransactions.delete(idx);
  else APP.selectedTransactions.add(idx);
  updateTransactionPicker();
}

export function toggleSelectAllTransactions() {
  const allCheckboxes = document.querySelectorAll('[data-txn-idx]');
  const checked = document.getElementById('txn-select-all').checked;
  APP.selectedTransactions.clear();
  if (checked) {
    allCheckboxes.forEach(cb => {
      const idx = parseInt(cb.dataset.txnIdx);
      APP.selectedTransactions.add(idx);
    });
  }
  updateTransactionPicker();
}

export function updateTransactionSelectionPanel() {
  const panel = document.getElementById('txn-selection-panel');
  const count = APP.selectedTransactions.size;
  if (count > 0) {
    document.getElementById('txn-selection-count').textContent = `${count} Buchung${count !== 1 ? 'en' : ''}`;
    panel.style.display = 'block';
  } else {
    panel.style.display = 'none';
  }
}

export function applyBulkReclassification() {
  const targetVal = document.getElementById('txn-bulk-target-sub').value;
  if (!targetVal) { showToast('Bitte Kategorie wählen'); return; }

  const [targetItemId, targetSubId] = targetVal.split('|');
  const selectedIndices = [...APP.selectedTransactions];

  selectedIndices.forEach(idx => {
    const txn = APP.allTransactions[idx];
    if (txn) txn._directMapping = { itemId: targetItemId, subId: targetSubId };
  });

  showToast(`${selectedIndices.length} Buchung${selectedIndices.length !== 1 ? 'en' : ''} zugeordnet`);
  clearTransactionSelection();
  buildPL();
}

export function clearTransactionSelection() {
  APP.selectedTransactions.clear();
  document.getElementById('txn-picker-search').value = '';
  document.getElementById('txn-select-all').checked = false;
  updateTransactionPicker();
}

export function renderRulesList() {
  const list = document.getElementById('rules-list');
  if (!APP.rules.length) {
    list.innerHTML = '<div style="color:#a0aabb;font-size:.78rem;padding:1rem;text-align:center">Noch keine Regeln erstellt</div>';
    return;
  }
  list.innerHTML = APP.rules.map((rule, idx) => {
    const item = APP.plDef.find(i => i.id === rule.targetItemId);
    const sub  = item?.subs?.find(s => s.id === rule.targetSubId);
    const desc = `${rule.matchOp} "${rule.matchValue}" → ${item?.label || '?'} / ${sub?.label || '?'}`;
    return `
      <div class="rule-item">
        <input type="checkbox" class="rule-toggle" ${rule.enabled ? 'checked' : ''} onchange="toggleRule('${rule.id}')">
        <div class="rule-details">
          <div class="rule-details-name">${esc(rule.name)}</div>
          <div class="rule-details-desc">${esc(desc)}</div>
        </div>
        <div class="rule-actions">
          <button class="rule-action-btn" onclick="deleteRule('${rule.id}')">×</button>
        </div>
      </div>
    `;
  }).join('');
}

export function toggleRule(ruleId) {
  const rule = APP.rules.find(r => r.id === ruleId);
  if (rule) rule.enabled = !rule.enabled;
  saveRules();
}

export function deleteRule(ruleId) {
  APP.rules = APP.rules.filter(r => r.id !== ruleId);
  saveRules();
}
