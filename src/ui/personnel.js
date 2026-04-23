/**
 * Personnel headcount UI — rendered when the plan detail view filters to 'personnel'.
 *
 * Renders a people table (name, role, country, salary, bonus, NK%, monthly cost)
 * with add/edit/delete and a generate-entries button.
 *
 * Depends on plan.js for refresh; plan.js passes a `refresh` callback via
 * setPersonnelRefresh() so this module never imports from plan.js (no circular deps).
 */

import { esc, MONTH_SHORT } from '../lib/utils.js';
import {
  getPersonnelDrivers, createPersonnelDriver, updatePersonnelDriver,
  deletePersonnelDriver, generatePersonnelEntries,
} from '../lib/db.js';
import { spreadPersonnel } from '../lib/plan-personnel.js';
import { showToast } from './screen.js';

const FMT = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

let _refresh = null;
let _personModal = { lineItemId: null, editId: null };

export function setPersonnelRefresh(fn) { _refresh = fn; }

// ── Main render ───────────────────────────────────────────────────────

export async function renderPersonnelView(container, lineItems, year, locked) {
  if (!lineItems.length) {
    container.innerHTML = `<div class="plan-empty">Noch keine Personalposten. Klicke "+ Position" und wähle "Personal".</div>`;
    return;
  }

  // Load all drivers for all personnel line items in parallel
  const allDrivers = [];
  await Promise.all(lineItems.map(async li => {
    try {
      const drivers = await getPersonnelDrivers(li.id);
      drivers.forEach(d => allDrivers.push({ ...d, _li: li }));
    } catch { /* ignore per-item errors */ }
  }));

  const showGroup = lineItems.length > 1;
  const liIds = lineItems.map(l => l.id).join(',');
  const defaultLiId = lineItems[0]?.id;

  const totals = _computeTotals(allDrivers, year);

  const thGroup  = showGroup ? '<th class="hc-th">Gruppe</th>' : '';
  const tdGroupFn = d => showGroup ? `<td class="hc-td"><span class="pg-li-tag">${esc(d._li.label)}</span></td>` : '';

  const headerRow = `
    <tr>
      ${thGroup}
      <th class="hc-th">Name</th>
      <th class="hc-th">Rolle</th>
      <th class="hc-th">Land</th>
      <th class="hc-th hc-num">Jahresgehalt</th>
      <th class="hc-th hc-num">Bonus</th>
      <th class="hc-th hc-num">AG-NK %</th>
      <th class="hc-th hc-num">Kosten/Mon</th>
      <th class="hc-th hc-num">p.a.</th>
      <th class="hc-th">Start</th>
      <th class="hc-th">Ende</th>
      ${!locked ? '<th class="hc-th"></th>' : ''}
    </tr>`;

  const bodyRows = allDrivers.map(d => {
    const entries     = spreadPersonnel(d, year);
    const annualCost  = entries.reduce((s, e) => s + e.amount, 0);
    const activeMonths = entries.filter(e => e.amount > 0).length || 1;
    const monthlyCost = annualCost / activeMonths;
    const nkPct       = d.payroll_burden_rate ? Math.round(Number(d.payroll_burden_rate) * 100) : null;

    return `
      <tr class="hc-row">
        ${tdGroupFn(d)}
        <td class="hc-td hc-name">
          ${esc(d.employee_name)}
          ${!d.is_filled ? '<span class="hc-badge-open">offen</span>' : ''}
        </td>
        <td class="hc-td">${esc(d.role_title || '—')}</td>
        <td class="hc-td">${esc(d.country || '—')}</td>
        <td class="hc-td hc-num">${FMT.format(Math.round(Number(d.annual_gross_salary)))}</td>
        <td class="hc-td hc-num">${d.annual_bonus ? FMT.format(Math.round(Number(d.annual_bonus))) : '—'}</td>
        <td class="hc-td hc-num">${nkPct !== null ? nkPct + ' %' : '—'}</td>
        <td class="hc-td hc-num hc-cost">${FMT.format(Math.round(monthlyCost))}</td>
        <td class="hc-td hc-num">${FMT.format(Math.round(annualCost))}</td>
        <td class="hc-td hc-date">${d.start_date ? String(d.start_date).slice(0, 7) : '—'}</td>
        <td class="hc-td hc-date">${d.end_date   ? String(d.end_date).slice(0, 7)   : '—'}</td>
        ${!locked ? `
          <td class="hc-td hc-actions">
            <button class="btn-sm hc-btn" onclick="editPerson(${d._li.id},${d.id})">✎</button>
            <button class="btn-sm hc-btn hc-btn-del" onclick="deletePerson(${d._li.id},${d.id})">✕</button>
          </td>` : ''}
      </tr>`;
  }).join('');

  const extraCols = (showGroup ? 1 : 0) + (!locked ? 1 : 0);
  const totalRow = allDrivers.length ? `
    <tr class="hc-total-row">
      ${showGroup ? '<td></td>' : ''}
      <td class="hc-total-label" colspan="3">Gesamt (${allDrivers.length} ${allDrivers.length === 1 ? 'Person' : 'Personen'})</td>
      <td class="hc-td hc-num">${FMT.format(Math.round(totals.salary))}</td>
      <td class="hc-td hc-num">${FMT.format(Math.round(totals.bonus))}</td>
      <td class="hc-td hc-num">—</td>
      <td class="hc-td hc-num hc-cost">${FMT.format(Math.round(totals.annualCost / 12))}</td>
      <td class="hc-td hc-num">${FMT.format(Math.round(totals.annualCost))}</td>
      <td colspan="${2 + (extraCols)}"></td>
    </tr>` : '';

  // Monthly cost breakdown: sum all drivers per month
  const monthlyTotals = Array.from({ length: 12 }, (_, i) => {
    return allDrivers.reduce((sum, d) => {
      const entries = spreadPersonnel(d, year);
      const entry = entries.find(e => e.month === i + 1);
      return sum + (entry?.amount ?? 0);
    }, 0);
  });
  const monthlyRow = `
    <div class="hc-monthly-bar">
      <div class="hc-monthly-title">Personalkosten / Monat</div>
      <div class="hc-monthly-cells">
        ${monthlyTotals.map((v, i) => `
          <div class="hc-monthly-cell">
            <div class="hc-monthly-label">${MONTH_SHORT[i]}</div>
            <div class="hc-monthly-val">${FMT.format(Math.round(v))}</div>
          </div>`).join('')}
      </div>
    </div>`;

  container.innerHTML = `
    <div class="hc-wrap">
      <div class="hc-toolbar">
        ${!locked ? `
          <button class="btn-plan-primary" style="font-size:.78rem;padding:.35rem .85rem" onclick="openPersonModal(${defaultLiId})">+ Person</button>
          <button class="btn-sm" onclick="generateAllPersonnel('${liIds}')" style="margin-left:.5rem">▶ Einträge generieren</button>
        ` : ''}
      </div>
      ${allDrivers.length === 0
        ? '<div class="plan-empty" style="padding:2rem">Noch keine Personen hinzugefügt. Klicke "+ Person".</div>'
        : `<div class="hc-table-wrap">
            <table class="hc-table">
              <thead>${headerRow}</thead>
              <tbody>${bodyRows}${totalRow}</tbody>
            </table>
          </div>
          ${monthlyRow}`
      }
    </div>`;
}

function _computeTotals(drivers, year) {
  let salary = 0, bonus = 0, annualCost = 0;
  for (const d of drivers) {
    salary     += Number(d.annual_gross_salary);
    bonus      += Number(d.annual_bonus || 0);
    annualCost += spreadPersonnel(d, year).reduce((s, e) => s + e.amount, 0);
  }
  return { salary, bonus, annualCost };
}

// ── Person modal ──────────────────────────────────────────────────────

export function openPersonModal(lineItemId, editId = null) {
  _personModal = { lineItemId, editId };
  const m = document.getElementById('person-modal');
  if (!m) return;
  document.getElementById('pm-title').textContent = editId ? 'Person bearbeiten' : 'Person hinzufügen';
  document.getElementById('pm-error').textContent = '';
  document.getElementById('pm-submit').textContent = editId ? 'Aktualisieren' : 'Hinzufügen';
  if (!editId) _resetPersonForm();
  m.style.display = 'flex';
}

export function closePersonModal() {
  const m = document.getElementById('person-modal');
  if (m) m.style.display = 'none';
}

export async function editPerson(lineItemId, personId) {
  try {
    const drivers = await getPersonnelDrivers(lineItemId);
    const d = drivers.find(x => x.id === personId);
    if (!d) { showToast('Person nicht gefunden'); return; }
    _fillPersonForm(d);
    openPersonModal(lineItemId, personId);
  } catch (e) { showToast('Fehler: ' + e.message); }
}

export async function deletePerson(lineItemId, personId) {
  if (!confirm('Person löschen?')) return;
  try {
    await deletePersonnelDriver(lineItemId, personId);
    showToast('Person gelöscht');
    if (_refresh) await _refresh();
  } catch (e) { showToast('Fehler: ' + e.message); }
}

export async function submitPerson() {
  const errEl = document.getElementById('pm-error');
  errEl.textContent = '';

  const name    = document.getElementById('pm-name').value.trim();
  const role    = document.getElementById('pm-role').value.trim();
  const country = document.getElementById('pm-country').value.trim();
  const salaryRaw = document.getElementById('pm-salary').value.replace(/\./g, '').replace(',', '.');
  const bonusRaw  = document.getElementById('pm-bonus').value.replace(/\./g, '').replace(',', '.');
  const nkRaw     = document.getElementById('pm-nk-pct').value.replace(',', '.');
  const start   = document.getElementById('pm-start').value || null;
  const end     = document.getElementById('pm-end').value   || null;

  const salary = parseFloat(salaryRaw);
  const bonus  = parseFloat(bonusRaw)  || 0;
  const nkPct  = parseFloat(nkRaw)     || 0;

  if (!name)                    { errEl.textContent = 'Name erforderlich.'; return; }
  if (isNaN(salary) || salary < 0) { errEl.textContent = 'Jahresgehalt angeben.'; return; }

  const payload = {
    employee_name:       name,
    role_title:          role    || null,
    country:             country || null,
    annual_gross_salary: salary,
    annual_bonus:        bonus,
    payroll_burden_rate: nkPct / 100,
    start_date:          start,
    end_date:            end,
    is_filled:           true,
    bonus_month:         12,
  };

  const btn = document.getElementById('pm-submit');
  btn.disabled = true;
  try {
    if (_personModal.editId) {
      await updatePersonnelDriver(_personModal.lineItemId, _personModal.editId, payload);
    } else {
      await createPersonnelDriver(_personModal.lineItemId, payload);
    }
    closePersonModal();
    showToast(_personModal.editId ? 'Person aktualisiert' : 'Person hinzugefügt');
    if (_refresh) await _refresh();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

export async function generateAllPersonnel(liIdsStr) {
  const liIds = String(liIdsStr).split(',').map(Number).filter(Boolean);
  try {
    let total = 0;
    for (const liId of liIds) {
      const result = await generatePersonnelEntries(liId);
      total += result.generated ?? 0;
    }
    showToast(`${total} Einträge generiert`);
    if (_refresh) await _refresh();
  } catch (e) { showToast('Fehler: ' + e.message); }
}

function _resetPersonForm() {
  ['pm-name','pm-role','pm-country','pm-salary','pm-bonus','pm-nk-pct','pm-start','pm-end']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}

function _fillPersonForm(d) {
  document.getElementById('pm-name').value    = d.employee_name ?? '';
  document.getElementById('pm-role').value    = d.role_title    ?? '';
  document.getElementById('pm-country').value = d.country       ?? '';
  document.getElementById('pm-salary').value  = d.annual_gross_salary != null
    ? FMT.format(Math.round(Number(d.annual_gross_salary))) : '';
  document.getElementById('pm-bonus').value   = d.annual_bonus
    ? FMT.format(Math.round(Number(d.annual_bonus))) : '';
  document.getElementById('pm-nk-pct').value  = d.payroll_burden_rate != null
    ? String(Math.round(Number(d.payroll_burden_rate) * 100)) : '';
  document.getElementById('pm-start').value   = d.start_date ? String(d.start_date).slice(0, 10) : '';
  document.getElementById('pm-end').value     = d.end_date   ? String(d.end_date).slice(0, 10)   : '';
}
