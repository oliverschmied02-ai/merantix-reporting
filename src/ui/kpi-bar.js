import { APP } from '../state.js';
import { fmtFull } from '../lib/utils.js';
import { loadKpiOrder, saveKpiOrder } from '../lib/storage.js';

export function renderKpiBar(ytdPL) {
  const revC = ytdPL.computed['revenue'] || 0;
  const _kpiDefs = {
    revenue:   { label: 'Umsatz YTD',   val: () => revC,                         sub: () => 'EUR' },
    ebitda:    { label: 'EBITDA YTD',   val: () => ytdPL.computed['ebitda']||0,  sub: v => revC ? ((v/revC)*100).toFixed(1)+'%' : '—' },
    ebit:      { label: 'EBIT YTD',     val: () => ytdPL.computed['ebit']||0,    sub: v => revC ? ((v/revC)*100).toFixed(1)+'%' : '—' },
    ebt:       { label: 'EBT YTD',      val: () => ytdPL.computed['ebt']||0,     sub: v => revC ? ((v/revC)*100).toFixed(1)+'%' : '—' },
    personnel: { label: 'Personalaufw.',val: () => ytdPL.computed['personnel']||0,sub: v => revC ? ((v/revC)*100).toFixed(1)+' % v. Umsatz' : '—' },
  };
  const kpiOrder = APP.kpiOrder || Object.keys(_kpiDefs);
  const kpiBar = document.getElementById('kpi-bar');
  kpiBar.innerHTML = `<div class="pl-summary" id="kpi-row">${
    kpiOrder.map(k => {
      const d = _kpiDefs[k]; if (!d) return '';
      const v = d.val();
      return `<div class="kpi" draggable="true" data-kpi="${k}">
        <div class="kpi-drag-handle">⠿</div>
        <div class="kpi-label">${d.label}</div>
        <div class="kpi-val">${fmtFull(v)}</div>
        <div class="kpi-sub">${d.sub(v)}</div>
      </div>`;
    }).join('')
  }</div>`;
  initKpiDrag();
}

export function initKpiDrag() {
  APP.kpiOrder = loadKpiOrder();
  let dragSrc = null;

  document.querySelectorAll('.kpi[draggable]').forEach(el => {
    el.addEventListener('dragstart', e => {
      dragSrc = el;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      document.querySelectorAll('.kpi').forEach(k => k.classList.remove('drag-over-kpi'));
    });
    el.addEventListener('dragover', e => {
      e.preventDefault();
      if (el !== dragSrc) {
        document.querySelectorAll('.kpi').forEach(k => k.classList.remove('drag-over-kpi'));
        el.classList.add('drag-over-kpi');
      }
    });
    el.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragSrc || dragSrc === el) return;
      const row = document.getElementById('kpi-row');
      const kids = [...row.children];
      const fromIdx = kids.indexOf(dragSrc);
      const toIdx   = kids.indexOf(el);
      if (fromIdx === -1 || toIdx === -1) return;
      if (fromIdx < toIdx) row.insertBefore(dragSrc, el.nextSibling);
      else row.insertBefore(dragSrc, el);
      const newOrder = [...row.children].map(k => k.dataset.kpi);
      saveKpiOrder(newOrder);
      document.querySelectorAll('.kpi').forEach(k => k.classList.remove('drag-over-kpi'));
    });
  });
}
