import { APP } from '../state.js';
import { esc, fmtK, fmtFull } from '../lib/utils.js';
import { computeAllPeriods } from '../lib/compute.js';
import { getRulesAffectingItem } from '../lib/resolve.js';
import { renderKpiBar } from './kpi-bar.js';
import { loadKpiOrder } from '../lib/storage.js';

export function buildPL() {
  const data = computeAllPeriods();
  if (!data) return;
  APP.plData = data;

  const { periodPLs, ytdPL, periods, year, mode } = data;
  const numP = periods.length;

  // Load saved KPI order before rendering
  APP.kpiOrder = loadKpiOrder();
  renderKpiBar(ytdPL);

  // Table header
  const thead = document.getElementById('pl-thead');
  let hRow = '<tr><th class="th-pos">Position</th>';
  for (let i = 0; i < numP; i++) {
    const p = periods[i];
    let cls = '';
    if (mode === 'monat' && [3, 6, 9].includes(p.idx)) cls = ' th-q' + Math.ceil(p.idx / 3);
    if (mode === 'quartal' && i > 0) cls = ' q-start';
    hRow += `<th class="${cls}" style="min-width:72px">${p.label}</th>`;
  }
  hRow += `<th class="th-ytd" style="min-width:88px">YTD ${year}</th></tr>`;
  thead.innerHTML = hRow;

  // Table body
  const tbody = document.getElementById('pl-tbody');
  tbody.innerHTML = '';
  const ytdRev = Math.max(ytdPL.computed['revenue'] || 0, 0.01);

  function cellColor(v, nb, isMixed) {
    if (v === 0) return 'vz';
    if (isMixed) return v > 0 ? 'vp' : 'vn';
    return nb === 'H' ? 'vp' : 'vn';
  }

  function makeCell(v, nb, isMixed, isYTD, periodIdx, acct, subId, itemId) {
    if (v === 0 && !isMixed) return `<td class="cell-zero">—</td>`;
    const cls = cellColor(v, nb, isMixed);
    const sign = !isMixed && nb === 'S' && v > 0 ? '− ' : '';
    const txt = isYTD ? fmtFull(Math.abs(v)) : fmtK(Math.abs(v));
    const pct = isYTD && ytdRev ? ` (${((Math.abs(v) / ytdRev) * 100).toFixed(1)}%)` : '';
    let drillAttr = '';
    if (acct !== undefined && periodIdx !== undefined) {
      drillAttr = ` class="data-cell" onclick="openDrill(${acct},'${subId}','${itemId}',${periodIdx})"`;
    }
    return `<td${drillAttr}><span class="${cls}">${sign}${txt}</span><span class="vm" style="font-size:.65rem">${pct}</span></td>`;
  }

  function addRow(trClass, posHtml, cells) {
    const tr = document.createElement('tr');
    tr.className = 'pl-row ' + trClass;
    const tdPos = document.createElement('td');
    tdPos.className = 'td-pos';
    tdPos.innerHTML = posHtml;
    tr.appendChild(tdPos);
    for (const c of cells) tr.insertAdjacentHTML('beforeend', c);
    tbody.appendChild(tr);
    return tr;
  }

  function addSep() {
    const tr = document.createElement('tr');
    tr.className = 'pl-row row-sep';
    tr.innerHTML = '<td class="td-pos"></td>' + '<td></td>'.repeat(numP + 1);
    tbody.appendChild(tr);
  }

  function addComputed(item) {
    const v_arr = periodPLs.map(pl => pl.computed[item.id] || 0);
    const vYTD = ytdPL.computed[item.id] || 0;
    const cls = vYTD > 0 ? 'vp' : vYTD < 0 ? 'vn' : 'vm';
    const tr = document.createElement('tr');
    tr.className = `pl-row row-computed ${item.id}`;
    let html = `<td class="td-pos">${esc(item.label)}</td>`;
    for (let i = 0; i < numP; i++) {
      const v = v_arr[i];
      const vcls = v > 0 ? 'vp' : v < 0 ? 'vn' : 'vm';
      const qborder = (mode === 'monat' && [3,6,9].includes(periods[i].idx)) || (mode === 'quartal' && i > 0)
        ? 'border-left:1px solid #e4e9f5' : '';
      html += `<td style="${qborder}"><span class="${vcls}">${fmtK(v)}</span></td>`;
    }
    html += `<td class="td-ytd"><span class="${cls}">${fmtFull(vYTD)}</span></td>`;
    tr.innerHTML = html;
    tbody.appendChild(tr);
    addSep();
  }

  for (const item of APP.plDef) {
    if (item.type === 'computed') { addComputed(item); continue; }

    if (item.type === 'ratio') {
      const v_arr = periodPLs.map(pl => pl.computed[item.id]);
      const vYTD = ytdPL.computed[item.id];
      const fmtRatio = v => (v === null || v === undefined) ? '—' : v.toFixed(1) + ' %';
      const clsRatio = v => (v === null || v === undefined) ? 'vm' : v >= 0 ? 'vp' : 'vn';
      const tr = document.createElement('tr');
      tr.className = 'pl-row row-ratio';
      let html = `<td class="td-pos" style="color:#4f6ef7;font-style:italic">${esc(item.label)}</td>`;
      for (let i = 0; i < numP; i++) {
        const v = v_arr[i];
        const qborder = (mode === 'monat' && [3,6,9].includes(periods[i].idx)) || (mode === 'quartal' && i > 0) ? 'border-left:1px solid #e4e9f5' : '';
        html += `<td style="${qborder};color:#4f6ef7;font-weight:600">${fmtRatio(v)}</td>`;
      }
      html += `<td class="td-ytd" style="color:#4f6ef7">${fmtRatio(vYTD)}</td>`;
      tr.innerHTML = html;
      tbody.appendChild(tr);
      addSep();
      continue;
    }

    const nb = item.normalBalance || 'S';
    const isMixed = item.type === 'section_mixed';
    const isExp = APP.expandedItems.has(item.id);
    const hasRules = getRulesAffectingItem(item.id).length > 0;

    const v_arr = periodPLs.map(pl => isMixed ? pl.computed[item.id] || 0 : pl.vals[item.id]?.amount || 0);
    const vYTD = isMixed ? ytdPL.computed[item.id] || 0 : ytdPL.vals[item.id]?.amount || 0;

    const tr = document.createElement('tr');
    tr.className = `pl-row row-section${isExp ? ' open' : ''}`;
    let posLabel = esc(item.label);
    if (hasRules) posLabel += `<span class="rule-indicator" title="Buchungsregeln aktiv"></span>`;
    let html = `<td class="td-pos"><span class="expand-btn">▶</span>${posLabel}</td>`;
    for (let i = 0; i < numP; i++) {
      const v = v_arr[i];
      const vcls = cellColor(v, nb, isMixed);
      const sign = !isMixed && nb === 'S' && v > 0 ? '− ' : '';
      const qborder = (mode === 'monat' && [3,6,9].includes(periods[i].idx)) || (mode === 'quartal' && i > 0) ? 'border-left:1px solid #e4e9f5' : '';
      html += `<td style="${qborder}"><span class="${vcls}">${v === 0 ? '—' : sign + fmtK(Math.abs(v))}</span></td>`;
    }
    const yvcls = cellColor(vYTD, nb, isMixed);
    const ysign = !isMixed && nb === 'S' && vYTD > 0 ? '− ' : '';
    html += `<td class="td-ytd"><span class="${yvcls}">${vYTD === 0 ? '—' : ysign + fmtFull(Math.abs(vYTD))}</span></td>`;
    tr.innerHTML = html;
    tr.addEventListener('click', () => toggleSection(item.id));
    tbody.appendChild(tr);

    for (const sub of item.subs) {
      const subNB = sub.normalBalance || nb;
      const subIsExp = APP.expandedSubs.has(sub.id);

      const sv_arr = periodPLs.map(pl => pl.vals[item.id]?.bySubId[sub.id]?.amount || 0);
      const svYTD = ytdPL.vals[item.id]?.bySubId[sub.id]?.amount || 0;

      if (sv_arr.every(v => v === 0) && svYTD === 0) continue;

      const trSub = document.createElement('tr');
      trSub.className = `pl-row row-sub${isExp ? '' : ' hidden'}${subIsExp ? ' open' : ''}`;
      let shtmlSub = `<td class="td-pos"><span class="expand-btn">▶</span>${esc(sub.label)}</td>`;
      for (let i = 0; i < numP; i++) {
        const v = sv_arr[i];
        const vcls = cellColor(v, subNB, false);
        const sign = subNB === 'S' && v > 0 ? '− ' : '';
        const qb = (mode === 'monat' && [3,6,9].includes(periods[i].idx)) || (mode === 'quartal' && i > 0) ? 'border-left:1px solid #e4e9f5' : '';
        shtmlSub += `<td style="${qb}"><span class="${vcls}">${v === 0 ? '—' : sign + fmtK(Math.abs(v))}</span></td>`;
      }
      const svcls = cellColor(svYTD, subNB, false);
      const sysign = subNB === 'S' && svYTD > 0 ? '− ' : '';
      shtmlSub += `<td class="td-ytd"><span class="${svcls}">${svYTD === 0 ? '—' : sysign + fmtFull(Math.abs(svYTD))}</span></td>`;
      trSub.innerHTML = shtmlSub;
      trSub.addEventListener('click', e => { e.stopPropagation(); toggleSub(item.id, sub.id); });
      tbody.appendChild(trSub);

      const allAccts = new Set();
      for (const pl of [...periodPLs, ytdPL]) {
        const ba = pl.vals[item.id]?.bySubId[sub.id]?.byAccount || {};
        for (const a of Object.keys(ba)) allAccts.add(+a);
      }
      for (const acct of [...allAccts].sort((a, b) => a - b)) {
        const av_arr = periodPLs.map(pl => pl.vals[item.id]?.bySubId[sub.id]?.byAccount[acct]?.amount || 0);
        const avYTD = ytdPL.vals[item.id]?.bySubId[sub.id]?.byAccount[acct]?.amount || 0;
        if (av_arr.every(v => v === 0) && avYTD === 0) continue;

        const aName = APP.accountNames.get(acct) || '';
        const visible = isExp && subIsExp;
        const trA = document.createElement('tr');
        trA.className = `pl-row row-acct${visible ? '' : ' hidden'}`;
        let ahtmlA = `<td class="td-pos">${acct}${aName ? ' · ' + esc(aName.slice(0, 28)) : ''}<span class="acct-drill">⬡</span></td>`;
        for (let i = 0; i < numP; i++) {
          const v = av_arr[i];
          const vcls = cellColor(v, subNB, false);
          const sign = subNB === 'S' && v > 0 ? '− ' : '';
          const qb = (mode === 'monat' && [3,6,9].includes(periods[i].idx)) || (mode === 'quartal' && i > 0) ? 'border-left:1px solid #e4e9f5' : '';
          ahtmlA += `<td style="${qb}" class="data-cell" onclick="openDrill(${acct},'${sub.id}','${item.id}',${i})"><span class="${vcls}">${v === 0 ? '—' : sign + fmtK(Math.abs(v))}</span></td>`;
        }
        const avcls = cellColor(avYTD, subNB, false);
        const aysign = subNB === 'S' && avYTD > 0 ? '− ' : '';
        ahtmlA += `<td class="td-ytd data-cell" onclick="openDrill(${acct},'${sub.id}','${item.id}',-1)"><span class="${avcls}">${avYTD === 0 ? '—' : aysign + fmtFull(Math.abs(avYTD))}</span></td>`;
        trA.innerHTML = ahtmlA;
        tbody.appendChild(trA);
      }
    }
  }

  // Unmapped accounts
  const allUnmapped = new Set();
  for (const pl of periodPLs) for (const a of pl.unmapped) allUnmapped.add(a);
  for (const a of ytdPL.unmapped) allUnmapped.add(a);
  const ud = document.getElementById('unmapped-details');
  const ul = document.getElementById('unmapped-list');
  if (allUnmapped.size > 0) {
    ud.classList.remove('hidden');
    ul.innerHTML = [...allUnmapped].sort((a, b) => a - b).map(a => {
      const n = APP.accountNames.get(a) || '';
      return `<span class="unmapped-tag" title="${esc(n)}">${a}${n ? ' · ' + esc(n.slice(0, 30)) : ''}</span>`;
    }).join('');
  } else ud.classList.add('hidden');
}

export function toggleSection(id) {
  if (APP.expandedItems.has(id)) APP.expandedItems.delete(id);
  else APP.expandedItems.add(id);
  buildPL();
}

export function toggleSub(itemId, subId) {
  if (APP.expandedSubs.has(subId)) APP.expandedSubs.delete(subId);
  else APP.expandedSubs.add(subId);
  buildPL();
}

export function setViewMode(mode) {
  APP.viewMode = mode;
  document.querySelectorAll('#view-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
  buildPL();
}

export function exportPLCSV() {
  if (!APP.plData) return;
  const { periodPLs, ytdPL, periods, year } = APP.plData;

  function csvCell(v) {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }
  function fmtNum(v) { return v === 0 ? '0' : v.toFixed(2).replace('.', ','); }

  const header = ['Position', ...periods.map(p => p.label), `YTD ${year}`];
  const rows = [header];

  for (const item of APP.plDef) {
    if (item.type === 'computed' || item.type === 'ratio') {
      const v_arr = periodPLs.map(pl => pl.computed[item.id] ?? 0);
      const vYTD  = ytdPL.computed[item.id] ?? 0;
      rows.push([item.label, ...v_arr.map(fmtNum), fmtNum(vYTD)]);
      rows.push([]);
      continue;
    }

    const isMixed = item.type === 'section_mixed';
    const v_arr = periodPLs.map(pl => isMixed ? pl.computed[item.id] || 0 : pl.vals[item.id]?.amount || 0);
    const vYTD  = isMixed ? ytdPL.computed[item.id] || 0 : ytdPL.vals[item.id]?.amount || 0;
    rows.push([item.label, ...v_arr.map(fmtNum), fmtNum(vYTD)]);

    for (const sub of item.subs) {
      const sv_arr = periodPLs.map(pl => pl.vals[item.id]?.bySubId[sub.id]?.amount || 0);
      const svYTD  = ytdPL.vals[item.id]?.bySubId[sub.id]?.amount || 0;
      if (sv_arr.every(v => v === 0) && svYTD === 0) continue;
      rows.push(['  ' + sub.label, ...sv_arr.map(fmtNum), fmtNum(svYTD)]);
    }
    rows.push([]);
  }

  const csv = rows.map(r => r.map(csvCell).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `PL_${year}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
