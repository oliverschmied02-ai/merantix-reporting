import { APP } from '../state.js';
import { esc, fmtFull } from '../lib/utils.js';

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
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">${search ? 'Keine Treffer' : 'Keine Buchungen'}</div></td></tr>`;
    return;
  }
  const sorted = [...filtered].sort((a, b) => (b.datum || 0) - (a.datum || 0));
  tbody.innerHTML = sorted.map(t => {
    const d = t.datum
      ? t.datum.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '—';
    const gn = t.gktonr ? APP.accountNames.get(t.gktonr) || '' : '';
    const gl = t.gktonr ? `${t.gktonr}${gn ? ' ' + gn.slice(0, 15) : ''}` : ' ';
    return `<tr>
      <td class="td-date">${d}</td>
      <td class="td-doc">${esc(t.beleg || '—')}</td>
      <td class="td-konto">${t.ktonr}</td>
      <td class="td-gkto" title="${esc(gn)}">${esc(gl.slice(0, 20))}</td>
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
