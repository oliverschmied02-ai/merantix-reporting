import { describe, it, expect, beforeEach } from 'vitest';
import { APP } from '../../src/state.js';
import { renderDrillTable, drillSort } from '../../src/ui/drill.js';

// Minimal drill-panel DOM that renderDrillTable()/drillSort() read from.
function setupDOM() {
  document.body.innerHTML = `
    <div id="drill-panel">
      <input id="drill-search" value="" />
      <table><thead><tr>
        <th class="drill-th" data-sortkey="datum"><span class="drill-sort-ind"></span></th>
        <th class="drill-th" data-sortkey="text"><span class="drill-sort-ind"></span></th>
        <th class="drill-th" data-sortkey="soll"><span class="drill-sort-ind"></span></th>
      </tr></thead><tbody id="drill-tbody"></tbody></table>
    </div>`;
}

const TXNS = [
  { datum: new Date('2026-03-01'), text: 'Zeta',  soll: 100, haben: 0, ktonr: 4000, gktonr: 1200, beleg: 'B3' },
  { datum: new Date('2026-01-15'), text: 'alpha', soll: 300, haben: 0, ktonr: 4000, gktonr: 1201, beleg: 'B1' },
  { datum: new Date('2026-02-10'), text: 'Mango', soll: 200, haben: 0, ktonr: 4000, gktonr: 1202, beleg: 'B2' },
];

const descColumn = () =>
  [...document.querySelectorAll('#drill-tbody .td-desc')].map(td => td.textContent);

const indicatorFor = key =>
  document.querySelector(`.drill-th[data-sortkey="${key}"] .drill-sort-ind`).textContent.trim();

describe('drill-down sorting', () => {
  beforeEach(() => { setupDOM(); APP.drillTxns = TXNS; });

  it('sorts numbers high→low then toggles low→high', () => {
    drillSort('soll');                         // new column → desc
    expect(descColumn()).toEqual(['alpha', 'Mango', 'Zeta']); // 300,200,100
    drillSort('soll');                         // same column → asc
    expect(descColumn()).toEqual(['Zeta', 'Mango', 'alpha']); // 100,200,300
  });

  it('sorts strings A→Z then toggles Z→A', () => {
    drillSort('text');                         // string → asc
    expect(descColumn()).toEqual(['alpha', 'Mango', 'Zeta']);
    drillSort('text');                         // toggle → desc
    expect(descColumn()).toEqual(['Zeta', 'Mango', 'alpha']);
  });

  it('sorts dates newest→oldest and marks the active header', () => {
    drillSort('datum');                        // date → desc (newest first)
    expect(descColumn()).toEqual(['Zeta', 'Mango', 'alpha']); // Mar, Feb, Jan
    expect(indicatorFor('datum')).toBe('▼');
    expect(indicatorFor('text')).toBe('');
  });
});
