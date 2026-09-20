'use strict';
/* Unit tests for investments/calc.js — FD interest, maturity, status, summary.
 * Run: node test/invest-calc.test.js
 */
var path = require('path');
var Calc = require(path.join(__dirname, '..', 'investments', 'calc.js'));

var passed = 0, failed = 0;
function eq(name, actual, expected) {
  if (actual === expected) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('FAIL  ' + name + ' — got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)); }
}
function close(name, actual, expected, tol) {
  tol = tol == null ? 1 : tol;
  if (actual != null && Math.abs(actual - expected) <= tol) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('FAIL  ' + name + ' — got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)); }
}

console.log('money/date helpers (shared with ipo, sanity)');
eq('inr groups', Calc.inr(200000), '₹2,00,000');
eq('inr lakh', Calc.inr(510000), '₹5,10,000');
eq('compact lakh', Calc.compact(510000), '₹5.10L');
eq('compact crore', Calc.compact(12500000), '₹1.25Cr');
eq('fmtDate', Calc.fmtDate('2027-05-28'), '28 May 2027');
eq('fmtDate empty', Calc.fmtDate(''), '—');

console.log('fdDays — explicit days vs computed from dates');
eq('uses days when present', Calc.fdDays({ amount: 1, rate: 1, days: 444, issueDate: '2026-01-01', maturityDate: '2026-02-01' }), 444);
eq('computes from dates when days missing', Calc.fdDays({ amount: 1, rate: 1, issueDate: '2026-01-01', maturityDate: '2026-01-10' }), 9);
eq('null when no dates or days', Calc.fdDays({ amount: 1, rate: 1 }), null);

console.log('fdInterest — simple interest P * r% * days/365');
close('400k @8.1% for 444d', Calc.fdInterest({ amount: 400000, rate: 8.1, days: 444 }), 39413, 1);
close('800k @8.1% for 444d', Calc.fdInterest({ amount: 800000, rate: 8.1, days: 444 }), 78825, 1);
close('1k @10% for 365d = 100', Calc.fdInterest({ amount: 1000, rate: 10, days: 365 }), 100, 1);
eq('no amount -> null', Calc.fdInterest({ rate: 8.1, days: 444 }), null);
eq('no rate -> null', Calc.fdInterest({ amount: 400000, days: 444 }), null);
eq('no term -> null', Calc.fdInterest({ amount: 400000, rate: 8.1 }), null);

console.log('fdExpectedTotal — bank value preferred, else P + interest');
eq('uses bank maturityValue when present', Calc.fdExpectedTotal({ amount: 400000, rate: 8.1, days: 444, maturityValue: 510000 }), 510000);
close('falls back to P + simple interest', Calc.fdExpectedTotal({ amount: 400000, rate: 8.1, days: 444 }), 439413, 1);

console.log('fdTax — tdsRate % of interest, default 10');
close('10% of 39413', Calc.fdTax({ amount: 400000, rate: 8.1, days: 444, tdsRate: 10 }), 3941.3, 0.5);
close('0% tds -> 0', Calc.fdTax({ amount: 400000, rate: 8.1, days: 444, tdsRate: 0 }), 0, 0);
close('default tdsRate (no field) = 10%', Calc.fdTax({ amount: 1000, rate: 10, days: 365 }), 10, 0.5);

console.log('fdStatus / sort / summary');
(function () {
  var active = { id: 'a', amount: 100, rate: 6, days: 300, issueDate: '2025-01-01', maturityDate: '2028-01-01', tdsRate: 0 };
  var matured = { id: 'b', amount: 200, rate: 6, days: 300, issueDate: '2020-01-01', maturityDate: '2021-01-01', tdsRate: 0 };
  var today = '2026-09-20';
  eq('future maturity -> active', Calc.fdStatus(active, today), 'active');
  eq('past maturity -> matured', Calc.fdStatus(matured, today), 'matured');
  eq('no maturity -> unknown', Calc.fdStatus({ amount: 1, rate: 1 }, today), 'unknown');

  var sorted = Calc.sortFds([active, matured], today);
  eq('sort: nearest maturity first (matured 2021)', sorted[0].id, 'b');
  eq('sort: farthest maturity second (active 2028)', sorted[1].id, 'a');
  eq('sort order length', sorted.length, 2);

  var s = Calc.fdSummary([active, matured], today);
  eq('summary count', s.count, 2);
  eq('summary active', s.active, 1);
  eq('summary matured', s.matured, 1);
  close('summary invested', s.invested, 300, 0);
})();

console.log('validFd');
(function () {
  eq('complete fd -> no errors', Calc.validFd({ account: '130910DP00004001', amount: 400000, rate: 8.1, issueDate: '2026-03-10', maturityDate: '2027-05-28' }).length, 0);
})();
(function () {
  var e = Calc.validFd({ account: '', amount: 0, rate: 0 });
  eq('missing fields -> 5 errors (acc, amt, rate, 2 dates)', e.length, 5);
})();
eq('maturity before issue flagged', Calc.validFd({ account: 'X', amount: 1, rate: 1, issueDate: '2027-01-01', maturityDate: '2026-01-01' }).some(function (x) { return /before issue/.test(x); }), true);

console.log('PAN / holder');
eq('normPan strips/uppercases', Calc.normPan(' ABCDE1234F '), 'ABCDE1234F');
(function () { eq('validPan ok', Calc.validPan({ pan: 'ABCDE1234F', name: 'TEST NAME' }).length, 0); })();
eq('validPan bad format', Calc.validPan({ pan: 'BADPAN', name: 'X' }).length, 1);
eq('holderLabel', Calc.holderLabel({ name: 'TEST NAME', pan: 'ABCDE1234F' }), 'TEST NAME · ABCDE1234F');
eq('holderLabel empty', Calc.holderLabel(null), '—');

console.log('day-first date parsing (DD/MM/YYYY)');
eq('dd/mm/yyyy -> iso', Calc.parseDDMMYYYY('27/08/2025'), '2025-08-27');
eq('single-digit dd/mm', Calc.parseDDMMYYYY('7/8/25'), '2025-08-07');
eq('iso passthrough', Calc.parseDDMMYYYY('2025-08-27'), '2025-08-27');
eq('invalid day (31 Feb) -> null', Calc.parseDDMMYYYY('31/02/2025'), null);
eq('invalid month -> null', Calc.parseDDMMYYYY('05/13/2025'), null);
eq('garbage -> null', Calc.parseDDMMYYYY('not a date'), null);
eq('empty -> null', Calc.parseDDMMYYYY(''), null);
eq('iso -> dd/mm/yyyy', Calc.isoToDDMMYYYY('2025-08-27'), '27/08/2025');
eq('iso empty -> empty', Calc.isoToDDMMYYYY(''), '');

console.log('interest ledger — compound (credited in)');
(function () {
  // Mirrors the 130910DP00004005 slip in 202608_consolidated.xlsx (8.1%, issue 2025-08-27).
  var fd = {
    amount: 400000, rate: 8.1, issueDate: '2025-08-27',
    entries: [
      { date: '2025-09-28', int: 3060, tax: 306 },
      { date: '2025-12-28', int: 8232, tax: 823 },
      { date: '2026-03-29', int: 8305, tax: 830 }
    ]
  };
  var rows = Calc.fdEntries(fd);
  eq('three rows', rows.length, 3);
  eq('row0 base = original principal', rows[0].base, 400000);
  eq('row0 days (issue->1st)', rows[0].days, 32);
  eq('row0 net (3060-306)', rows[0].net, 2754);
  eq('row0 after (400000+2754)', rows[0].after, 402754);
  close('row0 calc est ~ bank 2840', rows[0].expected, 2840, 40);
  eq('row1 base = running (402754)', rows[1].base, 402754);
  eq('row1 after', rows[1].after, 410163);
  close('row1 calc est ~ bank 8155', rows[1].expected, 8155, 60);
  var s = Calc.fdEntrySummary(fd);
  eq('summary count', s.count, 3);
  eq('summary gross', s.gross, 3060 + 8232 + 8305);
  eq('summary tax', s.tax, 306 + 823 + 830);
  eq('summary net', s.net, 2754 + 7409 + 7475);
  eq('summary after (worth now)', s.after, 400000 + 2754 + 7409 + 7475);
  eq('summary lastDate', s.lastDate, '2026-03-29');
})();

console.log('interest ledger — payout (principal fixed)');
(function () {
  var fd = {
    amount: 1000000, rate: 8.2, issueDate: '2026-02-19', interestMode: 'payout',
    entries: [
      { date: '2026-03-31', int: 9211, tax: 921 },
      { date: '2026-06-30', int: 20500, tax: 2050 }
    ]
  };
  var rows = Calc.fdEntries(fd);
  eq('mode normalized to payout', Calc.normInterestMode(fd), 'payout');
  eq('row0 base = principal', rows[0].base, 1000000);
  eq('row1 base = principal (not running)', rows[1].base, 1000000);
  var s = Calc.fdEntrySummary(fd);
  eq('summary net', s.net, (9211 - 921) + (20500 - 2050));
  eq('summary after (principal + net)', s.after, 1000000 + (9211 - 921) + (20500 - 2050));
})();

console.log('interest ledger — empty / zero');
(function () {
  var fd = { amount: 400000, rate: 8.1, issueDate: '2025-08-27' };
  eq('no entries -> empty rows', Calc.fdEntries(fd).length, 0);
  var s = Calc.fdEntrySummary(fd);
  eq('empty summary count', s.count, 0);
  eq('empty summary after = principal', s.after, 400000);
  eq('default mode is compound', Calc.normInterestMode({ amount: 1 }), 'compound');
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
