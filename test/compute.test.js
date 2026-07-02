import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { APP, resetAPP } from '../src/state.js';
import { rebuildAcctMap } from '../src/lib/resolve.js';
import { computePLSingle } from '../src/lib/compute.js';

// Default P&L maps 410000 → revenue/rev_main (H) and 600000 → personnel/pers_wages (S).
const rev  = haben => ({ ktonr: 410000, gktonr: null, soll: 0, haben, text: '', beleg: '' });
const wage = soll  => ({ ktonr: 600000, gktonr: null, soll, haben: 0, text: '', beleg: '' });

describe('computePLSingle — exact cent accumulation', () => {
  beforeEach(() => { resetAPP(); rebuildAcctMap(); });

  it('sums 0.10 values without binary-float drift', () => {
    // Naive float summation gives 0.30000000000000004; cent accumulation gives 0.30.
    const { vals } = computePLSingle([rev(0.10), rev(0.10), rev(0.10)]);
    assert.equal(vals.revenue.amount, 0.30);
    assert.equal(vals.revenue.bySubId.rev_main.amount, 0.30);
  });

  it('keeps a large mixed P&L exact to the cent', () => {
    const txns = [];
    for (let i = 0; i < 1000; i++) txns.push(rev(0.01));  // revenue   = 10.00
    for (let i = 0; i < 1000; i++) txns.push(wage(0.01)); // personnel = 10.00
    const { vals, computed } = computePLSingle(txns);
    assert.equal(vals.revenue.amount, 10.00);
    assert.equal(vals.personnel.amount, 10.00);
    // EBITDA = revenue − personnel − opex = 10 − 10 − 0 = 0 (exactly)
    assert.equal(computed.ebitda, 0);
  });

  it('nets debit and credit within an account exactly', () => {
    // 100.10 credit − 33.37 debit = 66.73 on a revenue (H) account.
    const { vals } = computePLSingle([rev(100.10), { ...rev(0), soll: 33.37 }]);
    assert.equal(vals.revenue.bySubId.rev_main.byAccount[410000].amount, 66.73);
  });

  it('leaves unmapped in-GuV accounts flagged, not summed', () => {
    const { unmapped } = computePLSingle([{ ktonr: 499999, gktonr: null, soll: 0, haben: 5, text: '', beleg: '' }]);
    // 499999 is in the GuV range but not in the default chart → reported as unmapped.
    assert.ok(unmapped.has(499999));
  });
});
