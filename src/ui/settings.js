import { APP } from '../state.js';
import { esc } from '../lib/utils.js';
import { deepClone } from '../lib/utils.js';
import { DEFAULT_PL_DEF } from '../data/default-pl.js';
import { saveCoA, saveRules } from '../lib/storage.js';
import { isInGUV } from '../lib/compute.js';
import { showToast } from './screen.js';
import { initTransactionPicker } from './rules.js';
import { renderRulesList } from './rules.js';

const SM_TAB_TITLES = {
  users:    'Benutzer',
  requests: 'Zugriffsanfragen',
  coa:      'Kontenplan',
  rules:    'Buchungsregeln',
  data:     'Daten & Verwaltung',
};

export function toggleSettings(show) {
  const modal = document.getElementById('settings-modal');
  if (show === undefined) show = !modal.classList.contains('open');
  modal.classList.toggle('open', show);
  if (show) {
    switchSettingsTab('users');
  }
}

export function switchSettingsTab(tab) {
  document.querySelectorAll('.sm-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.sm-tab-content').forEach(c => c.classList.add('hidden'));
  const content = document.getElementById(`sm-${tab}-tab`);
  if (content) content.classList.remove('hidden');
  const title = document.getElementById('sm-title');
  if (title) title.textContent = SM_TAB_TITLES[tab] || tab;
  if (tab === 'rules') initTransactionPicker();
  if (tab === 'coa') renderCoATree();
  if (tab === 'data') renderDataStats();
}

// Track open account picker
let _openPickerId = null;

export function renderCoATree() {
  const tree = document.getElementById('coa-tree');
  tree.innerHTML = '';

  const defLen = APP.plDef.length;

  APP.plDef.forEach((item, idx) => {
    const isFirst = idx === 0;
    const isLast  = idx === defLen - 1;
    const reorderBtns = `
      <div class="coa-reorder">
        <button class="coa-reorder-btn" onclick="movePlDefItem('${item.id}',-1)" title="Nach oben" ${isFirst?'disabled':''}>▲</button>
        <button class="coa-reorder-btn" onclick="movePlDefItem('${item.id}',+1)" title="Nach unten" ${isLast?'disabled':''}>▼</button>
      </div>`;

    // Computed rows: show as a separator/subtotal row (not editable, just reorderable)
    if (item.type === 'computed') {
      const div = document.createElement('div');
      div.className = 'coa-computed-row';
      div.innerHTML = `
        ${reorderBtns}
        <span class="coa-computed-label">${item.label}</span>
        <span class="coa-computed-badge">= Berechnet</span>`;
      tree.appendChild(div);
      return;
    }

    if (item.type === 'ratio') {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'coa-ratio-item';
      itemDiv.innerHTML = `
        <div class="coa-ratio-header">
          ${reorderBtns}
          <input type="text" class="coa-item-label-input" value="${esc(item.label)}" onchange="updateItemLabel('${item.id}',this.value)" style="flex:1">
          <span class="coa-ratio-badge">% Kennzahl</span>
          <button class="coa-btn" onclick="removeItem('${item.id}')" title="Löschen" style="margin-left:.3rem">×</button>
        </div>
        <div style="font-size:.68rem;color:#8b95a9;margin-bottom:.35rem;font-weight:600">Formel: Zähler ÷ Nenner × 100</div>
        <div class="coa-ratio-formula">
          <select onchange="updateRatioFormula('${item.id}','numerator',this.value)">
            ${APP.plDef.filter(i=>i.type==='computed'||i.type==='section'||i.type==='section_mixed').map(i=>`<option value="${i.id}" ${item.numerator===i.id?'selected':''}>${esc(i.label)}</option>`).join('')}
          </select>
          <div class="coa-ratio-div">÷</div>
          <select onchange="updateRatioFormula('${item.id}','denominator',this.value)">
            ${APP.plDef.filter(i=>i.type==='computed'||i.type==='section'||i.type==='section_mixed').map(i=>`<option value="${i.id}" ${item.denominator===i.id?'selected':''}>${esc(i.label)}</option>`).join('')}
          </select>
        </div>`;
      tree.appendChild(itemDiv);
      return;
    }

    const isMixed = item.type === 'section_mixed';
    const itemDiv = document.createElement('div');
    itemDiv.className = 'coa-item';

    let html = `
      <div class="coa-item-header">
        ${reorderBtns}
        <input type="text" class="coa-item-label-input" value="${esc(item.label)}" onchange="updateItemLabel('${item.id}',this.value)">
        ${!isMixed
          ? `<select class="coa-selector" onchange="updateItemBalance('${item.id}',this.value)">
              <option value="S" ${item.normalBalance==='S'?'selected':''}>Aufwand (S)</option>
              <option value="H" ${item.normalBalance==='H'?'selected':''}>Ertrag (H)</option>
            </select>`
          : `<span style="color:#a0aabb;font-size:.72rem;font-weight:600">Mixed</span>`}
        <div class="coa-buttons">
          <button class="coa-btn" onclick="addSubDialog('${item.id}')" title="Unterkategorie hinzufügen">+ Sub</button>
          <button class="coa-btn" onclick="removeItem('${item.id}')" title="Löschen">×</button>
        </div>
      </div>`;

    if (item.subs) {
      html += `<div class="coa-subs">`;
      for (const sub of item.subs) {
        const pickerId = `picker-${item.id}-${sub.id}`;
        html += `
          <div class="coa-sub">
            <div class="coa-sub-header">
              <input type="text" class="coa-sub-label" value="${esc(sub.label)}" onchange="updateSubLabel('${item.id}','${sub.id}',this.value)">
              <button class="coa-btn" onclick="removeSub('${item.id}','${sub.id}')" title="Löschen">×</button>
            </div>
            <div class="coa-accounts" id="chips-${item.id}-${sub.id}">
              ${(sub.accounts||[]).map(a=>`
                <span class="coa-chip">${a}${APP.accountNames.get(a)?' · '+esc(APP.accountNames.get(a).slice(0,18)):''}
                  <span class="coa-chip-remove" onclick="removeAccount('${item.id}','${sub.id}',${a})">×</span>
                </span>`).join('')}
            </div>
            <div class="acct-picker-wrap" id="wrap-${pickerId}">
              <button class="coa-add-account" onclick="toggleAcctPicker('${item.id}','${sub.id}')">+ Konto hinzufügen</button>
              <div class="acct-picker-dropdown hidden" id="${pickerId}">
                <div class="apd-search">
                  <input type="text" placeholder="Konto suchen (Nr. oder Name)…" oninput="filterAcctPicker('${item.id}','${sub.id}',this.value)" id="apd-input-${item.id}-${sub.id}" autocomplete="off">
                </div>
                <div class="apd-list" id="apd-list-${item.id}-${sub.id}"></div>
              </div>
            </div>
          </div>`;
      }
      html += `</div>`;
    }

    itemDiv.innerHTML = html;
    tree.appendChild(itemDiv);
  });
}

export function addSubDialog(itemId) {
  const item = APP.plDef.find(i => i.id === itemId);
  if (!item) return;
  const newSubId = itemId + '_sub_' + Date.now();
  item.subs.push({ id: newSubId, label: 'Neue Kategorie', accounts: [], normalBalance: item.normalBalance || 'S' });
  saveCoA();
}

export function toggleAcctPicker(itemId, subId) {
  const pid = `picker-${itemId}-${subId}`;
  const dropdown = document.getElementById(pid);
  if (!dropdown) return;
  const isOpen = !dropdown.classList.contains('hidden');

  if (_openPickerId && _openPickerId !== pid) {
    const prev = document.getElementById(_openPickerId);
    if (prev) prev.classList.add('hidden');
  }

  if (isOpen) {
    dropdown.classList.add('hidden');
    _openPickerId = null;
  } else {
    dropdown.classList.remove('hidden');
    _openPickerId = pid;
    filterAcctPicker(itemId, subId, '');
    setTimeout(() => {
      const inp = document.getElementById(`apd-input-${itemId}-${subId}`);
      if (inp) inp.focus();
    }, 50);
  }
}

export function initOutsidePickerClose() {
  document.addEventListener('click', e => {
    if (!_openPickerId) return;
    const dropdown = document.getElementById(_openPickerId);
    if (!dropdown) return;
    if (!dropdown.closest('.acct-picker-wrap').contains(e.target)) {
      dropdown.classList.add('hidden');
      _openPickerId = null;
    }
  });
}

export function filterAcctPicker(itemId, subId, query) {
  const listEl = document.getElementById(`apd-list-${itemId}-${subId}`);
  if (!listEl) return;
  const item = APP.plDef.find(i => i.id === itemId);
  const sub = item?.subs?.find(s => s.id === subId);
  if (!sub) return;

  const q = query.trim().toLowerCase();
  const allAccts = new Set([...APP.accountNames.keys()]);
  for (const t of APP.allTransactions) allAccts.add(t.ktonr);

  const mapped = [], free = [], elsewhere = [];

  for (const acct of [...allAccts].sort((a,b)=>a-b)) {
    if (!isInGUV(acct)) continue;
    const name = APP.accountNames.get(acct) || '';
    if (q && !String(acct).includes(q) && !name.toLowerCase().includes(q)) continue;

    const mapping = APP.acctMap.get(acct);
    if (sub.accounts.includes(acct)) {
      mapped.push({ acct, name });
    } else if (!mapping) {
      free.push({ acct, name });
    } else {
      const ownerItem = APP.plDef.find(i => i.id === mapping.itemId);
      const ownerSub = ownerItem?.subs?.find(s => s.id === mapping.subId);
      elsewhere.push({ acct, name, loc: `${ownerItem?.label||'?'} → ${ownerSub?.label||'?'}` });
    }
  }

  if (!free.length && !elsewhere.length && !mapped.length) {
    listEl.innerHTML = `<div class="apd-empty">Keine Konten gefunden</div>`;
    return;
  }

  let html = '';
  if (free.length) {
    html += `<div class="apd-section-hdr">Nicht zugeordnet (${free.length})</div>`;
    for (const { acct, name } of free) {
      html += `<div class="apd-item" onclick="addAccountToSub('${itemId}','${subId}',${acct})">
        <span class="apd-item-num">${acct}</span>
        <span class="apd-item-name">${esc(name||'—')}</span>
        <span class="apd-item-badge apd-badge-free">frei</span>
      </div>`;
    }
  }
  if (elsewhere.length) {
    html += `<div class="apd-section-hdr">Anderweitig zugeordnet (${elsewhere.length})</div>`;
    for (const { acct, name, loc } of elsewhere) {
      html += `<div class="apd-item">
        <span class="apd-item-num">${acct}</span>
        <span class="apd-item-name" title="${esc(name)}">${esc((name||'—').slice(0,22))}</span>
        <span class="apd-item-badge apd-badge-mapped" title="${esc(loc)}">${esc(loc.slice(0,20))}</span>
        <button class="apd-item-unmap show" onclick="unmapAndMove('${itemId}','${subId}',${acct})" title="Umbuchen hierher">↩ hierher</button>
      </div>`;
    }
  }
  if (mapped.length) {
    html += `<div class="apd-section-hdr">Bereits hier (${mapped.length})</div>`;
    for (const { acct, name } of mapped) {
      html += `<div class="apd-item">
        <span class="apd-item-num">${acct}</span>
        <span class="apd-item-name">${esc(name||'—')}</span>
        <span class="apd-item-badge apd-badge-here">✓ hier</span>
        <button class="apd-item-unmap show" onclick="removeAccount('${itemId}','${subId}',${acct})" style="color:#dc2626;border-color:#fecaca" title="Entfernen">× entf.</button>
      </div>`;
    }
  }
  listEl.innerHTML = html;
}

export function addAccountToSub(itemId, subId, acct) {
  const item = APP.plDef.find(i => i.id === itemId);
  const sub = item?.subs?.find(s => s.id === subId);
  if (sub && !sub.accounts.includes(acct)) {
    sub.accounts.push(acct);
    sub.accounts.sort((a,b) => a-b);
    saveCoA();
    const inp = document.getElementById(`apd-input-${itemId}-${subId}`);
    filterAcctPicker(itemId, subId, inp?.value || '');
  }
}

export function unmapAndMove(targetItemId, targetSubId, acct) {
  for (const it of APP.plDef) {
    if (!it.subs) continue;
    for (const s of it.subs) s.accounts = s.accounts.filter(a => a !== acct);
  }
  const item = APP.plDef.find(i => i.id === targetItemId);
  const sub = item?.subs?.find(s => s.id === targetSubId);
  if (sub && !sub.accounts.includes(acct)) {
    sub.accounts.push(acct);
    sub.accounts.sort((a,b) => a-b);
  }
  saveCoA();
  const inp = document.getElementById(`apd-input-${targetItemId}-${targetSubId}`);
  filterAcctPicker(targetItemId, targetSubId, inp?.value || '');
}

export function updateItemLabel(itemId, label) {
  const item = APP.plDef.find(i => i.id === itemId);
  if (item) item.label = label;
  saveCoA();
}

export function updateItemBalance(itemId, nb) {
  const item = APP.plDef.find(i => i.id === itemId);
  if (item) item.normalBalance = nb;
  saveCoA();
}

export function updateSubLabel(itemId, subId, label) {
  const item = APP.plDef.find(i => i.id === itemId);
  const sub = item?.subs?.find(s => s.id === subId);
  if (sub) sub.label = label;
  saveCoA();
}

export function removeAccount(itemId, subId, acct) {
  const item = APP.plDef.find(i => i.id === itemId);
  const sub = item?.subs?.find(s => s.id === subId);
  if (sub) sub.accounts = sub.accounts.filter(a => a !== acct);
  saveCoA();
}

export function removeSub(itemId, subId) {
  const item = APP.plDef.find(i => i.id === itemId);
  if (!item) return;
  const sub = item.subs?.find(s => s.id === subId);
  const label = sub ? `"${sub.label}"` : 'diese Unterkategorie';
  const orphanCount = APP.rules.filter(r => r.targetItemId === itemId && r.targetSubId === subId).length;
  const warning = orphanCount ? `\n\n${orphanCount} Buchungsregel(n) werden ebenfalls gelöscht.` : '';
  if (!confirm(`${label} löschen?${warning}`)) return;
  item.subs = item.subs.filter(s => s.id !== subId);
  APP.rules = APP.rules.filter(r => !(r.targetItemId === itemId && r.targetSubId === subId));
  saveCoA();
  saveRules();
}

export function removeItem(itemId) {
  const item = APP.plDef.find(i => i.id === itemId);
  if (!item) return;
  const orphanCount = APP.rules.filter(r => r.targetItemId === itemId).length;
  const warning = orphanCount ? `\n\n${orphanCount} Buchungsregel(n) werden ebenfalls gelöscht.` : '';
  if (!confirm(`"${item.label}" löschen?${warning}`)) return;
  APP.plDef = APP.plDef.filter(i => i.id !== itemId);
  APP.rules = APP.rules.filter(r => r.targetItemId !== itemId);
  saveCoA();
  saveRules();
}

// New Section Modal
let _nsType = 'section';

export function selectNsType(type) {
  _nsType = type;
  document.getElementById('ns-type-section').classList.toggle('selected', type === 'section');
  document.getElementById('ns-type-ratio').classList.toggle('selected', type === 'ratio');
  document.getElementById('ns-balance-field').style.display = type === 'section' ? '' : 'none';
  document.getElementById('ns-ratio-field').style.display = type === 'ratio' ? '' : 'none';
}

export function addNewSection() {
  _nsType = 'section';
  selectNsType('section');
  document.getElementById('ns-name').value = '';

  const opts = APP.plDef
    .filter(i => i.type === 'computed' || i.type === 'section' || i.type === 'section_mixed')
    .map(i => `<option value="${i.id}">${esc(i.label)}</option>`).join('');
  document.getElementById('ns-ratio-num').innerHTML = opts;
  document.getElementById('ns-ratio-den').innerHTML = opts;

  document.getElementById('new-section-modal').classList.add('open');
  setTimeout(() => document.getElementById('ns-name').focus(), 80);
}

export function closeNewSectionModal() {
  document.getElementById('new-section-modal').classList.remove('open');
}

export function confirmNewSection() {
  const name = document.getElementById('ns-name').value.trim();
  if (!name) { document.getElementById('ns-name').focus(); return; }

  const newId = 'custom_' + Date.now();

  if (_nsType === 'ratio') {
    const num = document.getElementById('ns-ratio-num').value;
    const den = document.getElementById('ns-ratio-den').value;
    APP.plDef.push({ id: newId, type: 'ratio', label: name, numerator: num, denominator: den });
  } else {
    const nb = document.getElementById('ns-balance').value;
    APP.plDef.push({
      id: newId, type: 'section', label: name, normalBalance: nb,
      subs: [{ id: newId + '_sub1', label: 'Neue Kategorie', accounts: [], normalBalance: nb }]
    });
  }

  closeNewSectionModal();
  saveCoA();
}

export function updateRatioFormula(itemId, field, value) {
  const item = APP.plDef.find(i => i.id === itemId);
  if (item) item[field] = value;
  saveCoA();
}

export function restoreDefaultPL() {
  if (confirm('Standard-Kontenplan wiederherstellen?')) {
    APP.plDef = deepClone(DEFAULT_PL_DEF);
    saveCoA();
  }
}

export function exportCoA() {
  const json = JSON.stringify(APP.plDef, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'gdpdu_coa_export.json'; a.click();
  URL.revokeObjectURL(url);
}

export function importCoADialog() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ee => {
      try {
        const imported = JSON.parse(ee.target.result);
        if (Array.isArray(imported)) {
          APP.plDef = imported;
          saveCoA();
          showToast('Kontenplan importiert');
        } else showToast('Ungültiges JSON-Format');
      } catch (err) {
        showToast('Import-Fehler: ' + err.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

export function renderDataStats() {
  const el = document.getElementById('sm-data-stats');
  if (!el) return;
  const years = [...new Set(APP.allTransactions.map(t => t.wjYear).filter(Boolean))].sort();
  el.innerHTML = `
    <div class="sm-stat-grid">
      <div class="sm-stat-card">
        <div class="sm-stat-val">${APP.loadedFiles.length}</div>
        <div class="sm-stat-label">Dateien geladen</div>
      </div>
      <div class="sm-stat-card">
        <div class="sm-stat-val">${APP.allTransactions.length.toLocaleString('de-DE')}</div>
        <div class="sm-stat-label">Buchungszeilen</div>
      </div>
      <div class="sm-stat-card">
        <div class="sm-stat-val">${years.join(', ') || '—'}</div>
        <div class="sm-stat-label">Geschäftsjahre</div>
      </div>
    </div>
    ${APP.loadedFiles.length ? `
    <div style="margin-top:1.5rem">
      <div style="font-size:.82rem;font-weight:700;color:#1e2433;margin-bottom:.75rem">Geladene Dateien</div>
      ${APP.loadedFiles.map(f => `
        <div style="display:flex;align-items:center;gap:.75rem;padding:.6rem .8rem;background:#f8f9fd;border-radius:8px;margin-bottom:.35rem;border:1px solid #e4e9f5">
          <div style="flex:1;min-width:0">
            <div style="font-size:.8rem;font-weight:600;color:#1e2433;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.name}</div>
            <div style="font-size:.7rem;color:#8b95a9">${f.txnCount?.toLocaleString('de-DE')} Buchungen · ${(f.years||[]).join(', ')}</div>
          </div>
          <button onclick="removeFile('${f.id}')" style="padding:.25rem .6rem;background:#fff;color:#dc2626;border:1px solid #fecaca;border-radius:6px;font-size:.72rem;cursor:pointer;font-family:inherit;flex-shrink:0">Entfernen</button>
        </div>`).join('')}
    </div>` : ''}`;
}

export function movePlDefItem(id, dir) {
  const fromIdx = APP.plDef.findIndex(i => i.id === id);
  if (fromIdx === -1) return;
  const toIdx = fromIdx + dir;
  if (toIdx < 0 || toIdx >= APP.plDef.length) return;
  [APP.plDef[fromIdx], APP.plDef[toIdx]] = [APP.plDef[toIdx], APP.plDef[fromIdx]];
  saveCoA();
}
