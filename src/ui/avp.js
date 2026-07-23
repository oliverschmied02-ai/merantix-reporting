/**
 * Actuals vs Plan (Ist/Plan) comparison view — with line-item drill-down.
 *
 * Combines:
 *   - Actuals from APP.plData.periodPLs  (already computed by the P&L engine)
 *   - Plan entries from the API for a selected version
 *
 * Renders a table with one row per P&L category, columns grouped by month:
 *   Ist | Plan | Δ  (repeated 12×, plus annual totals)
 *
 * The existing compareVersions() function handles all variance math.
 * This module only handles data assembly + rendering.
 */

import { APP } from '../state.js';
import { esc, MONTH_SHORT } from '../lib/utils.js';
import { getPlanVersions, getPlanLineItems, getPlanEntries } from '../lib/db.js';
import { aggregateByCategory, compareVersions, COMPARE_ROWS } from '../lib/plan-compare.js';
import { extractActualsFromPeriods, extractActualsYTD } from '../lib/actuals-compare.js';
import { computePLSingle } from '../lib/compute.js';
import { showToast } from './screen.js';

// ── Module state ──────────────────────────────────────────────────────

let _versions     = [];
let _selVersion   = null;
let _selYear      = null;
let _fromMonth    = 1;     // 1-12, start of range
let _upToMonth    = 12;    // 1-12, end of range (12 = full year)
let _lineItems    = [];   // line items for selected plan version
let _entries      = [];   // entries for selected plan version
let _expandedRows = new Set();  // category keys that are drilled down
let _lastExport   = null; // snapshot of the last rendered comparison, for CSV/PDF export

// ── Entry point ───────────────────────────────────────────────────────

export async function openAvpScreen() {
  _selYear      = currentYear();
  _selVersion   = null;
  _fromMonth    = 1;
  const latest  = latestActualMonth();
  _upToMonth    = Math.max(1, Math.min(12, latest || 12));
  _expandedRows = new Set();

  await loadVersionList();
  populateYearSelector();
  populateMonthSelector();
  renderAvpContent();
}

// ── Data loading ──────────────────────────────────────────────────────

async function loadVersionList() {
  try {
    _versions = await getPlanVersions();
  } catch (e) {
    _versions = [];
    showToast('Planversionen konnten nicht geladen werden: ' + e.message);
  }
  populateVersionSelector();
}

// ── Selectors ─────────────────────────────────────────────────────────

function populateYearSelector() {
  const sel = document.getElementById('avp-year-sel');
  if (!sel) return;
  const years = [...new Set(APP.years || [])].sort((a, b) => b - a);
  sel.innerHTML = years.length
    ? years.map(y => `<option value="${y}" ${y === _selYear ? 'selected' : ''}>${y}</option>`).join('')
    : `<option value="">Keine Daten geladen</option>`;
}

function populateVersionSelector() {
  const sel = document.getElementById('avp-version-sel');
  if (!sel) return;
  const year = _selYear;
  const forYear = _versions
    .filter(v => !year || v.year === year)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!forYear.length) {
    sel.innerHTML = `<option value="">— Keine Planversion für ${year} —</option>`;
    _selVersion = null;
    return;
  }

  sel.innerHTML = `<option value="">— Planversion wählen —</option>` +
    forYear.map(v =>
      `<option value="${v.id}" ${v.id === _selVersion ? 'selected' : ''}>${esc(v.name)} (${TYPE_LABEL[v.type] ?? v.type})</option>`
    ).join('');

  // Auto-select first budget version for the year
  if (!_selVersion) {
    const budget = forYear.find(v => v.type === 'budget') ?? forYear[0];
    if (budget) {
      sel.value = budget.id;
      _selVersion = budget.id;
    }
  }
}

function populateMonthSelector() {
  const fromSel = document.getElementById('avp-month-from-sel');
  const toSel = document.getElementById('avp-month-to-sel');
  if (!fromSel || !toSel) return;

  const latest = latestActualMonth();
  const monthOptions = MONTH_SHORT.map((m, i) => {
    const mo = i + 1;
    return `<option value="${mo}">${m}</option>`;
  }).join('');

  fromSel.innerHTML = monthOptions;
  toSel.innerHTML = monthOptions;

  fromSel.value = _fromMonth;
  toSel.value = _upToMonth;
}

// ── onChange handlers (called from HTML) ─────────────────────────────

export function avpChangeYear() {
  const sel = document.getElementById('avp-year-sel');
  _selYear = parseInt(sel?.value) || null;
  _selVersion = null;
  _expandedRows = new Set();
  populateVersionSelector();
  renderAvpContent();
}

export function avpChangeVersion() {
  const sel = document.getElementById('avp-version-sel');
  _selVersion = parseInt(sel?.value) || null;
  _expandedRows = new Set();
  renderAvpContent();
}

export function avpChangeMonthFrom() {
  const sel = document.getElementById('avp-month-from-sel');
  const v = parseInt(sel?.value) || 1;
  _fromMonth = Math.max(1, Math.min(12, v));
  // Ensure fromMonth <= upToMonth
  if (_fromMonth > _upToMonth) {
    _upToMonth = _fromMonth;
    const toSel = document.getElementById('avp-month-to-sel');
    if (toSel) toSel.value = _upToMonth;
  }
  renderAvpContent();
}

export function avpChangeMonthTo() {
  const sel = document.getElementById('avp-month-to-sel');
  const v = parseInt(sel?.value) || 12;
  _upToMonth = Math.max(1, Math.min(12, v));
  // Ensure fromMonth <= upToMonth
  if (_upToMonth < _fromMonth) {
    _fromMonth = _upToMonth;
    const fromSel = document.getElementById('avp-month-from-sel');
    if (fromSel) fromSel.value = _fromMonth;
  }
  renderAvpContent();
}

export function avpToggleDrilldown(key) {
  if (_expandedRows.has(key)) _expandedRows.delete(key);
  else _expandedRows.add(key);
  renderAvpContent();
}

// ── CSV / PDF export ──────────────────────────────────────────────────

// Revenue & EBITDA are "higher is better"; costs are "lower is better".
const higherIsBetter = key => key === 'revenue' || key === 'ebitda';

// Slugify a range label ("Jan–Mär") for use in a filename.
function safeSlug(s) {
  return String(s).replace(/[–—]/g, '-').replace(/[^\w-]+/g, '');
}

/**
 * Build a flat, structured list of display rows mirroring the on-screen table
 * — category rows (with Ist/Plan per month) plus the drill-down detail rows
 * (plan-only) for whichever categories are currently expanded. Shared by the
 * CSV and PDF exports so both reproduce exactly what the user sees.
 *
 * Each row: { style: 'cat'|'ebitda'|'group'|'item', label, indent, planOnly,
 *             key?, monthly: {m:{a?,b}}, ytd: {a?,b} }
 */
function buildExportRows(rows, visibleMonths, startMonth, endMonth, ytdActual, ytdPlan) {
  const drillableKeys = new Set(['revenue', 'personnel', 'opex']);

  const liEntryMap = new Map();
  for (const e of _entries) {
    if (!liEntryMap.has(e.line_item_id)) liEntryMap.set(e.line_item_id, {});
    liEntryMap.get(e.line_item_id)[e.month] = Number(e.amount);
  }
  const rangeYtd = amounts => {
    let s = 0;
    for (let m = startMonth; m <= endMonth; m++) s += amounts[m] ?? 0;
    return s;
  };
  const monthlyPlan = amounts => {
    const out = {};
    for (const m of visibleMonths) out[m] = { b: amounts[m] ?? 0 };
    return out;
  };

  const out = [];
  for (const row of rows) {
    const monthly = {};
    for (const m of visibleMonths) {
      const c = row.monthly[m] ?? { a: 0, b: 0 };
      monthly[m] = { a: c.a, b: c.b };
    }
    out.push({
      style: row.computed ? 'ebitda' : 'cat', key: row.key, label: row.label,
      indent: 0, planOnly: false, monthly,
      ytd: { a: ytdActual[row.key] ?? 0, b: ytdPlan[row.key] ?? 0 },
    });

    if (!drillableKeys.has(row.key) || !_expandedRows.has(row.key)) continue;
    const catItems = _lineItems.filter(li => li.category === row.key);
    if (!catItems.length) continue;

    if (row.key === 'opex') {
      // Preserve the sBA sub-category grouping (Fremdleistungen, Events …).
      const opexDef  = APP.plDef.find(s => s.id === 'opex');
      const subs     = opexDef?.subs ?? [];
      const subLabel = new Map(subs.map(s => [s.id, s.label]));
      const byItem   = new Map();
      for (const li of catItems) {
        const k = subLabel.has(li.item_id) ? li.item_id : '_other';
        if (!byItem.has(k)) byItem.set(k, []);
        byItem.get(k).push(li);
      }
      const orderedKeys = [
        ...subs.map(s => s.id).filter(k => byItem.has(k)),
        ...(byItem.has('_other') ? ['_other'] : []),
      ];
      for (const k of orderedKeys) {
        const lis = byItem.get(k);
        const groupAmounts = {};
        for (const li of lis) {
          const a = liEntryMap.get(li.id) || {};
          for (const [m, v] of Object.entries(a)) groupAmounts[m] = (groupAmounts[m] || 0) + v;
        }
        out.push({
          style: 'group', label: subLabel.get(k) || 'Sonstiges', indent: 1, planOnly: true,
          monthly: monthlyPlan(groupAmounts), ytd: { b: rangeYtd(groupAmounts) },
        });
        for (const li of lis) {
          const a = liEntryMap.get(li.id) || {};
          out.push({
            style: 'item', label: li.label + (li.entity ? ` (${li.entity})` : ''), indent: 2, planOnly: true,
            monthly: monthlyPlan(a), ytd: { b: rangeYtd(a) },
          });
        }
      }
    } else {
      for (const li of catItems) {
        const a = liEntryMap.get(li.id) || {};
        out.push({
          style: 'item', label: li.label + (li.entity ? ` (${li.entity})` : ''), indent: 1, planOnly: true,
          monthly: monthlyPlan(a), ytd: { b: rangeYtd(a) },
        });
      }
    }
  }
  return out;
}

/**
 * Download the current Ist/Plan comparison as CSV — full month-by-month
 * detail (Ist, Plan, Δ per visible month) plus the range totals, including
 * the expanded drill-down detail rows (plan-only). Semicolon-separated with a
 * UTF-8 BOM and German decimal commas, so it opens cleanly in Excel (de-DE).
 */
export function avpExportCSV() {
  if (!_lastExport) { showToast('Bitte zuerst ein Jahr und eine Planversion wählen.'); return; }
  const { exportRows, visibleMonths, versionLabel, yearLabel, rangeLabel } = _lastExport;

  const csvCell = v => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const num   = v => (!v) ? '0' : (Math.round(v * 100) / 100).toFixed(2).replace('.', ',');
  const blank = '';

  const lines = [];
  lines.push([`Ist vs. Plan ${yearLabel}`]);
  lines.push(['Planversion', versionLabel]);
  lines.push(['Zeitraum', rangeLabel]);
  lines.push(['Exportiert am', new Date().toLocaleDateString('de-DE')]);
  lines.push([]);

  const header = ['Position'];
  for (const m of visibleMonths) {
    const mo = MONTH_SHORT[m - 1];
    header.push(`${mo} Ist`, `${mo} Plan`, `${mo} Δ`);
  }
  header.push('Gesamt Ist', 'Gesamt Plan', 'Gesamt Δ');
  lines.push(header);

  for (const row of exportRows) {
    const indent = '  '.repeat(row.indent);
    const cells = [indent + row.label];
    for (const m of visibleMonths) {
      const c = row.monthly[m] ?? {};
      if (row.planOnly) cells.push(blank, num(c.b), blank);
      else cells.push(num(c.a), num(c.b), num(round2((c.a ?? 0) - (c.b ?? 0))));
    }
    if (row.planOnly) cells.push(blank, num(row.ytd.b), blank);
    else cells.push(num(row.ytd.a), num(row.ytd.b), num(round2((row.ytd.a ?? 0) - (row.ytd.b ?? 0))));
    lines.push(cells);
  }

  const csv  = lines.map(r => r.map(csvCell).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `Ist-vs-Plan_${yearLabel}_${safeSlug(rangeLabel)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Open a print-friendly report in a new window and trigger the browser's print
 * dialog (→ "Als PDF speichern"). Mirrors the on-screen table: per-month
 * Ist/Plan/Δ columns plus the range totals, and the expanded drill-down rows.
 * Landscape; font/columns scale down as more months are shown.
 */
export function avpExportPrint() {
  if (!_lastExport) { showToast('Bitte zuerst ein Jahr und eine Planversion wählen.'); return; }
  const { exportRows, visibleMonths, hasActuals, versionLabel, yearLabel, rangeLabel } = _lastExport;

  const fmtN = v => (!v) ? '—'
    : new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(Math.round(v));
  const fmtD = v => {
    if (!v) return '—';
    const abs = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(Math.abs(Math.round(v)));
    return (v > 0 ? '+' : '−') + abs;
  };

  const n = visibleMonths.length;
  // Scale down type/padding as month count grows so it stays on one page width.
  const fs   = n <= 6 ? 7 : n <= 9 ? 6 : 5.4;
  const pad  = n <= 6 ? '3px 5px' : n <= 9 ? '2px 4px' : '1.5px 3px';
  const posW = n <= 6 ? 150 : n <= 9 ? 120 : 100;

  const deltaClass = (key, d) => !hasActuals || d === 0 ? 'zero'
    : higherIsBetter(key) ? (d > 0 ? 'good' : 'bad') : (d < 0 ? 'good' : 'bad');

  const numTd = (v, extra = '') => `<td class="num ${extra}">${fmtN(v)}</td>`;
  const monthCells = row => visibleMonths.map((m, i) => {
    const c   = row.monthly[m] ?? {};
    const sep = i === 0 ? '' : ' grp';
    if (row.planOnly) {
      return `<td class="num${sep}"></td>${numTd(c.b, 'plan')}<td class="num"></td>`;
    }
    const d = round2((c.a ?? 0) - (c.b ?? 0));
    return `${numTd(c.a, 'ist' + sep)}${numTd(c.b, 'plan')}<td class="num delta ${deltaClass(row.key, d)}">${fmtD(d)}</td>`;
  }).join('');

  const totalCells = row => {
    if (row.planOnly) return `<td class="num ytd grp"></td>${numTd(row.ytd.b, 'plan ytd')}<td class="num ytd"></td>`;
    const d = round2((row.ytd.a ?? 0) - (row.ytd.b ?? 0));
    return `${numTd(row.ytd.a, 'ist ytd grp')}${numTd(row.ytd.b, 'plan ytd')}<td class="num delta ytd ${deltaClass(row.key, d)}">${fmtD(d)}</td>`;
  };

  const bodyRows = exportRows.map(row => `
    <tr class="row-${row.style} ind-${row.indent}">
      <td class="pos">${esc(row.label)}</td>
      ${monthCells(row)}${totalCells(row)}
    </tr>`).join('');

  const monthHead = visibleMonths.map((m, i) =>
    `<th colspan="3" class="mhead${i === 0 ? '' : ' grp'}">${MONTH_SHORT[m - 1]}</th>`
  ).join('') + `<th colspan="3" class="mhead ytdhead grp">Gesamt ${esc(rangeLabel)}</th>`;
  const subHead = visibleMonths.map((_, i) =>
    `<th class="sub${i === 0 ? '' : ' grp'}">Ist</th><th class="sub">Plan</th><th class="sub">Δ</th>`
  ).join('') + `<th class="sub grp">Ist</th><th class="sub">Plan</th><th class="sub">Δ</th>`;

  const exportDate = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Ist vs. Plan ${esc(yearLabel)}</title>
<style>
  @page { size: A4 landscape; margin: 10mm 8mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: ${fs}pt; color: #1e2433; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 5mm; }
  .header h1 { font-size: 13pt; font-weight: 700; }
  .header .sub { font-size: 8pt; color: #4b5563; margin-top: 3px; }
  .header .meta { font-size: 7.5pt; color: #6b7280; text-align: right; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th { background: #1e2433; color: #fff; font-weight: 600; text-align: right; padding: ${pad}; white-space: nowrap; }
  th.mhead { text-align: center; font-size: ${fs}pt; }
  th.mhead.grp { border-left: 2px solid #3a4a6a; }
  th.ytdhead { background: #2d3a5a; }
  th.sub { font-size: ${fs - 0.6}pt; font-weight: 500; color: #c9d2e6; padding: 1px 3px; }
  th.sub.grp { border-left: 2px solid #566; }
  td { padding: ${pad}; border-bottom: 1px solid #eef1f6; overflow: hidden; text-overflow: ellipsis; }
  td.pos { text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.plan { color: #4f5bd5; }
  td.grp { border-left: 1px solid #e3e7f0; }
  td.ytd { background: #f4f6fb; }
  td.delta.good { color: #158a4a; }
  td.delta.bad  { color: #c8362f; }
  td.delta.zero { color: #9aa3b2; }
  .row-cat td { font-weight: 600; background: #f8f9fd; }
  .row-ebitda td { font-weight: 700; background: #eef1ff; }
  .row-group td.pos { font-weight: 600; padding-left: 14px; }
  .row-item td.pos { color: #4b5563; padding-left: 26px; }
  .row-item td.plan, .row-group td.plan { color: #6b73c9; }
  .foot { margin-top: 4mm; font-size: 7pt; color: #6b7280; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>Ist vs. Plan ${esc(yearLabel)}</h1>
    <div class="sub">Plan: ${esc(versionLabel)} · Zeitraum: ${esc(rangeLabel)}</div>
  </div>
  <div class="meta">Exportiert am ${exportDate}<br>Alle Beträge in EUR</div>
</div>
<table>
  <colgroup><col style="width:${posW}px"></colgroup>
  <thead>
    <tr><th rowspan="2" style="text-align:left">Position</th>${monthHead}</tr>
    <tr>${subHead}</tr>
  </thead>
  <tbody>${bodyRows}</tbody>
</table>
<div class="foot">Δ = Ist − Plan · grün = über Plan (Umsatz/EBITDA) bzw. unter Plan (Kosten) · Detailzeilen zeigen nur Planwerte${!hasActuals ? ' · Für diesen Zeitraum sind noch keine Ist-Buchungen erfasst.' : ''}</div>
</body>
</html>`;

  const w = window.open('', '_blank', 'width=1200,height=800');
  if (!w) { showToast('Popup blockiert — bitte Popups für diese Seite erlauben.'); return; }
  w.document.write(html);
  w.document.close();
  w.onload = () => w.print();
}

// ── Main render ───────────────────────────────────────────────────────

async function renderAvpContent() {
  const el = document.getElementById('avp-content');
  if (!el) return;

  // Any early return below means there is no full Ist/Plan table to export.
  _lastExport = null;

  if (!_selYear) {
    el.innerHTML = `<div class="plan-empty">Kein Jahr ausgewählt. Bitte GDPdU-Datei laden.</div>`;
    return;
  }

  // Get actuals for selected year
  const allTxns = APP.allTransactions.filter(t => t.wjYear === _selYear);
  if (!allTxns.length) {
    el.innerHTML = `<div class="plan-empty">Keine Buchungsdaten für ${_selYear} geladen. Bitte zuerst eine GDPdU-Datei importieren.</div>`;
    return;
  }

  // Compute actuals per month using existing engine
  const { periodPLs } = computePeriodsForYear(_selYear);
  const actualMonthly = extractActualsFromPeriods(periodPLs);

  if (!_selVersion) {
    // Show actuals-only summary while no plan version is selected
    renderActualsOnly(el, actualMonthly, periodPLs);
    return;
  }

  el.innerHTML = `<div class="plan-loading">Plandaten laden…</div>`;

  try {
    const [lineItems, entries] = await Promise.all([
      // Only active line items: a plan position deleted (soft-deleted) in the
      // planning view must disappear here too. aggregateByCategory maps entries
      // to a category via this list, so entries of deleted line items are
      // excluded from the plan totals as well, not just the drill-down.
      getPlanLineItems(_selVersion, { activeOnly: true }),
      getPlanEntries(_selVersion),
    ]);

    _lineItems = lineItems;
    _entries   = entries;

    const planMonthly = aggregateByCategory(lineItems, entries);
    const rows        = compareVersions(actualMonthly, planMonthly);

    el.innerHTML = renderTable(rows, periodPLs, _fromMonth, _upToMonth);
  } catch (e) {
    el.innerHTML = `<div class="plan-error">Fehler: ${esc(e.message)}</div>`;
    showToast('Fehler: ' + e.message);
  }
}

function renderActualsOnly(el, actualMonthly, periodPLs) {
  const ytd  = extractActualsForRange(periodPLs, _fromMonth, _upToMonth);

  const rows = COMPARE_ROWS.map(row => ({
    ...row,
    ytdActual: ytd[row.key] ?? 0,
  }));

  const isEbitdaRow = r => r.computed;
  const fromLabel = MONTH_SHORT[_fromMonth - 1];
  const toLabel = MONTH_SHORT[_upToMonth - 1];
  const rangeLabel = _fromMonth === _upToMonth ? fromLabel : `${fromLabel}–${toLabel}`;

  el.innerHTML = `
    <div class="avp-wrap">
      <div class="avp-no-plan-hint">
        Wähle eine Planversion um Ist/Plan-Abweichungen zu sehen.
      </div>
      <table class="avp-table avp-table-simple">
        <thead>
          <tr>
            <th class="avp-label-head">Position</th>
            <th class="avp-num-head">Ist (${rangeLabel})</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr class="${isEbitdaRow(row) ? 'avp-row-ebitda' : 'avp-row'}">
              <td class="avp-label">${esc(row.label)}</td>
              <td class="avp-num">${fmtActual(row.ytdActual)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderTable(rows, periodPLs, fromMonth, upTo) {
  // Sanitize inputs
  const fm = Math.max(1, Math.min(12, fromMonth || 1));
  const ut = Math.max(1, Math.min(12, upTo || 12));
  const startMonth = Math.min(fm, ut);
  const endMonth = Math.max(fm, ut);

  const version   = _versions.find(v => v.id === _selVersion);
  const versionLabelRaw = version ? `${version.name} (${TYPE_LABEL[version.type] ?? version.type})` : 'Plan';
  const versionName = esc(versionLabelRaw);
  const yearLabel   = _selYear ?? '';
  const fromLabel   = MONTH_SHORT[startMonth - 1] || 'Jan';
  const toLabel     = MONTH_SHORT[endMonth - 1] || 'Dez';
  const rangeLabel  = startMonth === endMonth ? fromLabel : `${fromLabel}–${toLabel}`;
  const ytdActual   = extractActualsForRange(periodPLs, startMonth, endMonth);

  // Build YTD plan totals
  const ytdPlan = {};
  for (const row of rows) {
    ytdPlan[row.key] = 0;
    for (let m = startMonth; m <= endMonth; m++) {
      ytdPlan[row.key] += row.monthly[m]?.b ?? 0;
    }
  }

  // Variance colouring: revenue & EBITDA are "higher is better"; costs are
  // "lower is better". Used consistently by the KPI cards and the table.
  const higherIsBetter = key => key === 'revenue' || key === 'ebitda';
  const varClass = (key, d) =>
    d === 0 ? 'zero' : higherIsBetter(key) ? (d > 0 ? 'pos' : 'neg') : (d < 0 ? 'pos' : 'neg');
  // Whether any actuals exist in the range (else the whole Ist side is empty
  // and every Δ would scream −100% — we dim it and show a hint instead).
  const hasActuals = Object.values(ytdActual).some(v => Math.round(v) !== 0);

  // KPI summary bar (top 4: Revenue, Personnel, OpEx, EBITDA)
  const kpiKeys = ['revenue', 'personnel', 'opex', 'ebitda'];
  const kpiRows = rows.filter(r => kpiKeys.includes(r.key));

  const kpiBar = kpiRows.map(r => {
    const act  = ytdActual[r.key] ?? 0;
    const plan = ytdPlan[r.key]   ?? 0;
    const delta = round2(act - plan);
    const pct   = plan !== 0 ? Math.round((delta / Math.abs(plan)) * 100) : null;
    const cls   = !hasActuals ? 'zero'
      : delta === 0 ? 'zero'
      : higherIsBetter(r.key) ? (delta > 0 ? 'good' : 'bad') : (delta < 0 ? 'good' : 'bad');
    return `
      <div class="avp-kpi ${r.computed ? 'avp-kpi-ebitda' : ''}">
        <div class="avp-kpi-label">${esc(r.label)}</div>
        <div class="avp-kpi-val">${act !== 0 ? fmtActual(act) : '<span class="avp-kpi-empty">—</span>'}</div>
        <div class="avp-kpi-foot">
          <span class="avp-kpi-plan">Plan ${fmtActual(plan)}</span>
          <span class="avp-kpi-delta ${cls}">${delta > 0 ? '+' : ''}${fmtActual(delta)}${pct !== null ? ` · ${pct} %` : ''}</span>
        </div>
      </div>`;
  }).join('');

  // Month header columns (only for range)
  const visibleMonths = Array.from({ length: endMonth - startMonth + 1 }, (_, i) => startMonth + i);

  const monthHeaders = visibleMonths.map(m =>
    `<th colspan="3" class="avp-month-head">${MONTH_SHORT[m - 1]}</th>`
  ).join('') + `<th colspan="3" class="avp-annual-head">Gesamt ${rangeLabel}</th>`;

  const subHeaders = visibleMonths.map(() =>
    `<th class="avp-sub ist">Ist</th><th class="avp-sub plan">Plan</th><th class="avp-sub delta">Δ</th>`
  ).join('') + `<th class="avp-sub ist avp-ytd-sep">Ist</th><th class="avp-sub plan">Plan</th><th class="avp-sub delta">Δ</th>`;

  const drillableKeys = new Set(['revenue', 'personnel', 'opex']);

  // Build entry map for drill-down
  const liEntryMap = new Map();
  for (const e of _entries) {
    if (!liEntryMap.has(e.line_item_id)) liEntryMap.set(e.line_item_id, {});
    liEntryMap.get(e.line_item_id)[e.month] = Number(e.amount);
  }

  const bodyRows = rows.flatMap(row => {
    const isEbitda    = row.computed;
    const isDrillable = drillableKeys.has(row.key);
    const isExpanded  = _expandedRows.has(row.key);
    const rowClass    = isEbitda ? 'avp-row avp-row-ebitda' : 'avp-row';

    const monthlyCells = visibleMonths.map(m => {
      const cell   = row.monthly[m] ?? { a: 0, b: 0 };
      const ist    = cell.a;
      const plan   = cell.b;
      const ivp    = round2(ist - plan);
      const ivpCls = varClass(row.key, ivp);
      return `
        <td class="avp-cell ist">${fmtActual(ist)}</td>
        <td class="avp-cell plan">${fmtActual(plan)}</td>
        <td class="avp-cell delta avp-delta-${ivpCls}">${fmtDelta(ivp)}</td>`;
    }).join('');

    const ytdAct = ytdActual[row.key] ?? 0;
    const ytdPl  = ytdPlan[row.key]   ?? 0;
    const ytdIvp = round2(ytdAct - ytdPl);
    const ytdPct = ytdPl !== 0 ? ((ytdIvp / Math.abs(ytdPl)) * 100).toFixed(1) : null;
    const ytdCls = varClass(row.key, ytdIvp);

    const drillChevron = isDrillable ? `
      <span class="avp-drill-chevron ${isExpanded ? 'expanded' : ''}">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="${isExpanded ? '18 15 12 9 6 15' : '6 9 12 15 18 9'}"/></svg>
      </span>` : `<span class="avp-drill-chevron-placeholder"></span>`;

    const mainRow = `
      <tr class="${rowClass} ${isDrillable ? 'avp-row-drillable' : ''}"
          ${isDrillable ? `data-act="avpToggleDrilldown" data-act-args="[&quot;${row.key}&quot;]"` : ''}>
        <td class="avp-label">
          ${drillChevron}${esc(row.label)}
        </td>
        ${monthlyCells}
        <td class="avp-cell ist avp-ytd avp-ytd-sep">${fmtActual(ytdAct)}</td>
        <td class="avp-cell plan avp-ytd">${fmtActual(ytdPl)}</td>
        <td class="avp-cell delta avp-ytd avp-delta-${ytdCls}">
          ${fmtDelta(ytdIvp)}
          ${ytdPct !== null ? `<br><span class="avp-pct">${ytdIvp >= 0 ? '+' : ''}${ytdPct}%</span>` : ''}
        </td>
      </tr>`;

    if (!isDrillable || !isExpanded) return [mainRow];

    // Drill-down: show individual line items (plan amounts only — no actuals at line-item level)
    const catItems = _lineItems.filter(li => li.category === row.key);

    if (!catItems.length) {
      return [mainRow, `
        <tr class="avp-drill-row">
          <td class="avp-drill-label" colspan="${3 * visibleMonths.length + 4}" style="padding-left:2.5rem;color:#a0aabb;font-style:italic">
            Keine Positionen definiert
          </td>
        </tr>`];
    }

    // Plan-only monthly cells (Ist/Δ columns stay blank at line-item level)
    const planCells = amounts => visibleMonths.map(m => {
      const v = amounts[m] ?? 0;
      return `
        <td class="avp-cell avp-drill-cell"></td>
        <td class="avp-cell avp-drill-cell plan">${v !== 0 ? fmtActual(v) : '<span class="avp-zero">—</span>'}</td>
        <td class="avp-cell avp-drill-cell"></td>`;
    }).join('');
    const rangeYtd = amounts => {
      let s = 0;
      for (let m = startMonth; m <= endMonth; m++) s += amounts[m] ?? 0;
      return s;
    };

    const liDrillRow = li => {
      const a = liEntryMap.get(li.id) || {};
      const ytd = rangeYtd(a);
      return `
        <tr class="avp-drill-row">
          <td class="avp-drill-label">
            <span class="avp-drill-indent">↳</span>
            ${esc(li.label)}
            ${li.entity ? `<span class="avp-drill-tag">${esc(li.entity)}</span>` : ''}
          </td>
          ${planCells(a)}
          <td class="avp-cell avp-drill-cell avp-ytd avp-ytd-sep"></td>
          <td class="avp-cell avp-drill-cell plan avp-ytd">${ytd !== 0 ? fmtActual(ytd) : '<span class="avp-zero">—</span>'}</td>
          <td class="avp-cell avp-drill-cell avp-ytd"></td>
        </tr>`;
    };

    // OpEx keeps its sBA sub-category structure (Fremdleistungen, Events …):
    // group the line items by item_id and show a subtotal row per group, so
    // the drill-down mirrors the planning grid instead of a flat list.
    if (row.key === 'opex') {
      const opexDef  = APP.plDef.find(s => s.id === 'opex');
      const subs     = opexDef?.subs ?? [];
      const subLabel = new Map(subs.map(s => [s.id, s.label]));
      const byItem   = new Map();
      for (const li of catItems) {
        const key = subLabel.has(li.item_id) ? li.item_id : '_other';
        if (!byItem.has(key)) byItem.set(key, []);
        byItem.get(key).push(li);
      }
      const orderedKeys = [
        ...subs.map(s => s.id).filter(k => byItem.has(k)),
        ...(byItem.has('_other') ? ['_other'] : []),
      ];
      const out = [mainRow];
      for (const key of orderedKeys) {
        const lis = byItem.get(key);
        // sub-category subtotal = sum of its line items
        const groupAmounts = {};
        for (const li of lis) {
          const a = liEntryMap.get(li.id) || {};
          for (const [m, v] of Object.entries(a)) groupAmounts[m] = (groupAmounts[m] || 0) + v;
        }
        const gYtd = rangeYtd(groupAmounts);
        out.push(`
          <tr class="avp-drill-row avp-drill-group">
            <td class="avp-drill-label avp-drill-group-label">${esc(subLabel.get(key) || 'Sonstiges')}</td>
            ${planCells(groupAmounts)}
            <td class="avp-cell avp-drill-cell avp-ytd avp-ytd-sep"></td>
            <td class="avp-cell avp-drill-cell plan avp-ytd">${gYtd !== 0 ? fmtActual(gYtd) : '<span class="avp-zero">—</span>'}</td>
            <td class="avp-cell avp-drill-cell avp-ytd"></td>
          </tr>`);
        for (const li of lis) out.push(liDrillRow(li));
      }
      return out;
    }

    return [mainRow, ...catItems.map(liDrillRow)];
  }).join('');

  // Snapshot everything the CSV/PDF export needs to reproduce this exact view,
  // including the drill-down detail rows for whichever categories are expanded.
  _lastExport = {
    exportRows: buildExportRows(rows, visibleMonths, startMonth, endMonth, ytdActual, ytdPlan),
    visibleMonths, startMonth, endMonth, hasActuals,
    versionLabel: versionLabelRaw, yearLabel: String(yearLabel), rangeLabel,
  };

  return `
    <div class="avp-wrap">
      <div class="avp-meta">
        <span class="avp-meta-year">${yearLabel}</span>
        <span class="avp-meta-sep">·</span>
        <span class="avp-meta-plan">Plan: ${versionName}</span>
        <span class="avp-meta-sep">·</span>
        <span class="avp-meta-period">Zeitraum: ${rangeLabel}</span>
        <span class="avp-meta-note">Δ = Ist − Plan · grün = über Plan (Umsatz) / unter Plan (Kosten)</span>
      </div>

      ${!hasActuals ? `<div class="avp-hint">Für ${yearLabel} sind noch keine Ist-Buchungen erfasst — es werden nur die Planwerte angezeigt.</div>` : ''}

      <div class="avp-kpi-bar">${kpiBar}</div>

      <div class="avp-table-scroll">
        <table class="avp-table${hasActuals ? '' : ' avp-table--noactuals'}">
          <thead>
            <tr>
              <th class="avp-label-head" rowspan="2">Position</th>
              ${monthHeaders}
            </tr>
            <tr>${subHeaders}</tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────

const TYPE_LABEL = { budget: 'Budget', forecast: 'Forecast', scenario: 'Szenario' };
const FMT = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function fmtActual(v) {
  if (v === 0) return '<span class="avp-zero">—</span>';
  return FMT.format(Math.round(v));
}

function fmtDelta(v) {
  if (v === 0) return '<span class="avp-zero">—</span>';
  const abs = FMT.format(Math.abs(Math.round(v)));
  return v > 0 ? `+${abs}` : `−${abs}`;
}

function currentYear() {
  const sel = document.getElementById('year-sel');
  const v   = parseInt(sel?.value);
  if (v) return v;
  const years = APP.years ?? [];
  return years.length ? Math.max(...years) : null;
}

function latestActualMonth() {
  // Return the most recent month that has actual data in the current year
  const year = currentYear();
  if (!year) return 12;
  const months = [...new Set(
    APP.allTransactions.filter(t => t.wjYear === year).map(t => t.wjMonth)
  )].filter(Boolean);
  return months.length ? Math.max(...months) : 12;
}

function computePeriodsForYear(year) {
  const yearTxns = APP.allTransactions.filter(t => t.wjYear === year);
  const periodPLs = [];
  for (let m = 1; m <= 12; m++) {
    const mTxns = yearTxns.filter(t => t.wjMonth === m);
    periodPLs.push(computePLSingle(mTxns));
  }
  return { periodPLs };
}

function round2(n) { return Math.round(n * 100) / 100; }

function extractActualsForRange(periodPLs, fromMonth, upToMonth) {
  const ytd = {};
  for (const row of COMPARE_ROWS) ytd[row.key] = 0;

  const CATEGORY_TO_PL_KEY = {
    revenue:      'revenue',
    personnel:    'personnel',
    opex:         'opex',
    depreciation: 'depreciation',
  };

  for (let m = fromMonth; m <= upToMonth; m++) {
    const i = m - 1;
    const computed = periodPLs[i]?.computed ?? {};
    for (const [cat, plKey] of Object.entries(CATEGORY_TO_PL_KEY)) {
      ytd[cat] = round2((ytd[cat] || 0) + (computed[plKey] ?? 0));
    }
  }

  // Re-derive EBITDA from components
  ytd['ebitda'] = round2(ytd['revenue'] - ytd['personnel'] - ytd['opex']);
  return ytd;
}
