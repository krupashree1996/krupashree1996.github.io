'use strict';
/* Unit tests for ipo/calc.js default-lots behaviour.
 * Run: node test/ipo-calc.test.js
 */
var path = require('path');
var Calc = require(path.join(__dirname, '..', 'ipo', 'calc.js'));

var passed = 0, failed = 0;
function eq(name, actual, expected) {
  if (actual === expected) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('FAIL  ' + name + ' — got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)); }
}

console.log('defaultLots — mainline');
eq('mainline defaults to 1', Calc.defaultLots('Mainline', { bandHi: 1000, shareLot: 9 }), 1);
eq('mainline with no price', Calc.defaultLots('Mainline', {}), 1);
eq('mainline, category only (no ipo obj)', Calc.defaultLots('Mainline'), 1);
eq('unknown category treated as mainline', Calc.defaultLots(undefined, { bandHi: 100, shareLot: 10 }), 1);
eq('unknown category, no ipo', Calc.defaultLots(null), 1);

console.log('defaultLots — sme (target ₹200,000)');
eq('sme: 2000/lot → 100 lots (exactly 2,00,000)', Calc.defaultLots('SME', { bandHi: 200, shareLot: 10 }), 100);
eq('sme: 250/lot → 80 lots (exactly 2,00,000)', Calc.defaultLots('SME', { bandHi: 250, shareLot: 10 }), 80);
eq('sme: 90/lot, 9 sh/lot → 247 lots (₹810/lot; 2,00,070 ≥ 2,00,000)', Calc.defaultLots('SME', { bandHi: 90, shareLot: 9 }), 247);
eq('sme: 20/lot, 9 sh/lot → 1,112 lots (₹180/lot; 2,00,160; 1,111 lots = 1,99,980 < 2,00,000)', Calc.defaultLots('SME', { bandHi: 20, shareLot: 9 }), 1112);
eq('sme: 150/lot, 5 sh/lot → 267 lots (₹750/lot; 2,00,250)', Calc.defaultLots('SME', { bandHi: 150, shareLot: 5 }), 267);
eq('sme: 3000/lot → 67 lots (₹3,000/lot; 2,01,000 ≥ 2,00,000)', Calc.defaultLots('SME', { bandHi: 3000, shareLot: 1 }), 67);
eq('sme: expensive 10000/lot → 20 lots', Calc.defaultLots('SME', { bandHi: 10000, shareLot: 1 }), 20);
eq('sme: no price → falls back to 1', Calc.defaultLots('SME', {}), 1);
eq('sme: no shareLot → falls back to 1', Calc.defaultLots('SME', { bandHi: 200 }), 1);
eq('sme: zero price → falls back to 1', Calc.defaultLots('SME', { bandHi: 0, shareLot: 10 }), 1);
eq('sme: zero shareLot → falls back to 1', Calc.defaultLots('SME', { bandHi: 200, shareLot: 0 }), 1);

console.log('defaultLots — invariants');
(function () {
  // for any SME combo, result must satisfy lots*bandHi*shareLot >= 200000 (except degenerate 1)
  var combos = [
    [45, 100], [101, 100], [99.95, 10], [1, 100], [0.5, 500]
  ];
  var bad = [];
  combos.forEach(function (c) {
    var lots = Calc.defaultLots('SME', { bandHi: c[0], shareLot: c[1] });
    var amt = lots * c[0] * c[1];
    if (amt < 200000 && !(lots === 1 && c[0] * c[1] < 200000)) bad.push(c + '→' + lots + '=' + amt);
  });
  eq('SME never under-targets when feasible', bad.length, 0);
  if (bad.length) console.log('  ' + bad.join('; '));
})();

console.log('defaultLots — regression: old mainline default was 3, now must be 1');
eq('mainline no longer 3', Calc.defaultLots('Mainline', { bandHi: 500, shareLot: 2 }), 1);

console.log('related money helpers (sanity, unchanged)');
eq('inr groups', Calc.inr(200000), '₹2,00,000');
eq('minAmount uses ipo.minLots', Calc.minAmount({ bandHi: 200, shareLot: 10, minLots: 2 }), 4000);
eq('appAmount lots', Calc.appAmount({ bandHi: 200, shareLot: 10 }, 100), 200000);

console.log('ipoStatus / sortIpos unaffected');
(function () {
  var today = '2026-09-11';
  eq('open status', Calc.ipoStatus({ openDate: '2026-09-01', closeDate: '2026-09-15' }, today), 'open');
  eq('listed status', Calc.ipoStatus({ openDate: '2026-08-01', closeDate: '2026-08-05', listingDate: '2026-08-20' }, today), 'listed');
  eq('watch with no dates', Calc.ipoStatus({ status: 'watch' }, today), 'watch');
})();

console.log('normRemote still sets minLots=1 for external snapshots');
var r = Calc.normRemote({ companyName: 'Acme', priceBand: { max: 250 }, lotSize: 10, series: 'SME' });
eq('external SME minLots', r.minLots, 1);
eq('external bandHi', r.bandHi, 250);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
