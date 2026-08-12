import { APP } from '../state.js';
import { esc, fmtFull } from '../lib/utils.js';

// Sortable columns in the drill-down table and their value types. Strings sort
// A→Z by default, numbers/dates sort high→low (newest / largest first).
const DRILL_COLS = {
  datum: 'date', beleg: 'str', ktonr: 'num', gktonr: 'num',
  text: 'str', soll: 'num', haben: 'num',
};
let _sortKey = 'datum';
let _sortDir = 'desc';

export function drillSort(key) {
  if (!(key in DRILL_COLS)) return;
  if (_sortKey === key) {
    _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    _sortKey = key;
    _sortDir = DRILL_COLS[key] === 'str' ? 'asc' : 'desc';
  }
  renderDrillTable();
}

// Coerce an amount that may arrive as a JS number, a plain numeric string
// ("1250.50"), or a German-formatted string ("1.250,50") into a number.
function toNum(v) {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  let s = String(v).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // de → en
  return Number(s) || 0;
}

function sortTxns(list) {
  const dir  = _sortDir === 'asc' ? 1 : -1;
  const type = DRILL_COLS[_sortKey] || 'str';
  const primary = (a, b) => {
    const av = a[_sortKey], bv = b[_sortKey];
    if (type === 'date') return ((av ? av.getTime() : 0) - (bv ? bv.getTime() : 0)) * dir;
    if (type === 'num')  return (toNum(av) - toNum(bv)) * dir;
    return (av ?? '').toString().localeCompare((bv ?? '').toString(), 'de', { numeric: true }) * dir;
  };
  // Stable, meaningful tiebreaker: rows whose primary value is equal (e.g. every
  // Haben = 0 in an expense account, or the same Konto throughout) still fall
  // into a sensible order — newest first — instead of looking unsorted.
  const byDateDesc = (a, b) => (b.datum ? b.datum.getTime() : 0) - (a.datum ? a.datum.getTime() : 0);
  return [...list].sort((a, b) => primary(a, b) || (_sortKey === 'datum' ? 0 : byDateDesc(a, b)));
}

function updateDrillSortIndicators() {
  document.querySelectorAll('#drill-panel .drill-th').forEach(th => {
    const active = th.dataset.sortkey === _sortKey;
    th.classList.toggle('sorted', active);
    const ind = th.querySelector('.drill-sort-ind');
    if (ind) ind.textContent = active ? (_sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  });
}

export function openDrill(acct, subId, itemId, periodIdx) {
  const { periodPLs, ytdPL, periods, year } = APP.plData;

  let pl, periodLabel;
  if (periodIdx === -1) {
    pl = ytdPL;
    periodLabel = `YTD ${year}`;
  } else {
    pl = periodPLs[periodIdx];
    periodLabel = periods[periodIdx].label + ' ' + year;
  }

  const txns = pl.vals[itemId]?.bySubId[subId]?.byAccount[acct]?.txns || [];
  const aName = APP.accountNames.get(acct) || '';
  const sub = APP.plDef.flatMap(i => i.subs || []).find(s => s.id === subId);

  document.getElementById('drill-title').textContent = `${acct}${aName ? ' · ' + aName : ''}`;
  document.getElementById('drill-period').textContent = periodLabel;
  document.getElementById('drill-sub').textContent = sub?.label || '';
  document.getElementById('drill-search').value = '';

  const soll  = txns.reduce((s, t) => s + t.soll, 0);
  const haben = txns.reduce((s, t) => s + t.haben, 0);
  document.getElementById('drill-stats').innerHTML = `
    <div class="drill-stat"><label>Buchungen</label><span class="sv">${txns.length}</span></div>
    <div class="drill-stat"><label>Soll-Summe</label><span class="sv">${fmtFull(soll)} €</span></div>
    <div class="drill-stat"><label>Haben-Summe</label><span class="sv">${fmtFull(haben)} €</span></div>
    <div class="drill-stat"><label>Saldo</label><span class="sv" style="color:${soll - haben >= 0 ? '#22c55e' : '#ef4444'}">${fmtFull(soll - haben)} €</span></div>
  `;

  APP.drillTxns = txns;
  renderDrillTable();
  document.getElementById('drill-panel').classList.add('open');
  document.getElementById('overlay').classList.add('open');
}

export function renderDrillTable() {
  const search = document.getElementById('drill-search').value.toLowerCase().trim();
  const txns = APP.drillTxns;
  const filtered = !search
    ? txns
    : txns.filter(t =>
        t.text?.toLowerCase().includes(search) ||
        t.beleg?.toLowerCase().includes(search) ||
        String(t.ktonr).includes(search) ||
        String(t.gktonr || '').includes(search),
      );

  const tbody = document.getElementById('drill-tbody');
  updateDrillSortIndicators();
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">${search ? 'Keine Treffer' : 'Keine Buchungen'}</div></td></tr>`;
    return;
  }
  const sorted = sortTxns(filtered);
  tbody.innerHTML = sorted.map(t => {
    const d = t.datum
      ? t.datum.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '—';
    const gn = t.gktonr ? APP.accountNames.get(t.gktonr) || '' : '';
    const gl = t.gktonr ? `${t.gktonr}${gn ? ' ' + gn.slice(0, 24) : ''}` : ' ';
    return `<tr>
      <td class="td-date">${d}</td>
      <td class="td-doc">${esc(t.beleg || '—')}</td>
      <td class="td-konto">${t.ktonr}</td>
      <td class="td-gkto" title="${esc(gn)}">${esc(gl.slice(0, 32))}</td>
      <td class="td-desc" title="${esc(t.text)}">${esc(t.text || '—')}</td>
      <td class="td-amt ${t.soll  > 0 ? 'sh-s' : 'sz'}">${t.soll  > 0 ? fmtFull(t.soll)  : '—'}</td>
      <td class="td-amt ${t.haben > 0 ? 'sh-h' : 'sz'}">${t.haben > 0 ? fmtFull(t.haben) : '—'}</td>
    </tr>`;
  }).join('');
}

export function closeDrill() {
  document.getElementById('drill-panel').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
}
