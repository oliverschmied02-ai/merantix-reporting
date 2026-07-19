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
import { aggregateByCategory, compareVersions, rangeTotal, COMPARE_ROWS } from '../lib/plan-compare.js';
import { extractActualsFromPeriods, extractActualsForRange } from '../lib/actuals-compare.js';
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

// ── Main render ───────────────────────────────────────────────────────

async function renderAvpContent() {
  const el = document.getElementById('avp-content');
  if (!el) return;

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
  const versionName = esc(version ? `${version.name} (${TYPE_LABEL[version.type] ?? version.type})` : 'Plan');
  const yearLabel   = _selYear ?? '';
  const fromLabel   = MONTH_SHORT[startMonth - 1] || 'Jan';
  const toLabel     = MONTH_SHORT[endMonth - 1] || 'Dez';
  const rangeLabel  = startMonth === endMonth ? fromLabel : `${fromLabel}–${toLabel}`;
  const ytdActual   = extractActualsForRange(periodPLs, startMonth, endMonth);

  // Build YTD plan totals over exactly the same range as the actuals side.
  const ytdPlan = {};
  for (const row of rows) {
    const planByMonth = {};
    for (let m = 1; m <= 12; m++) planByMonth[m] = row.monthly[m]?.b ?? 0;
    ytdPlan[row.key] = rangeTotal(planByMonth, startMonth, endMonth);
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
    // Sum line-item plan amounts over the SAME [startMonth, endMonth] range as
    // the parent category total, so the drill-down rows always add up to the
    // "Gesamt" plan figure shown on the category row (previously this ignored
    // the "from" month and leaked in earlier months when the range didn't start
    // in January).
    const rangeYtd = amounts => rangeTotal(amounts, startMonth, endMonth);

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
