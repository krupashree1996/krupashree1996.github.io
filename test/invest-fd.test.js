'use strict';
/* Unit tests for investments/fd.js — PNB slip parser on synthetic text items.
 * The items mirror the real pdf.js geometry of a "Confirmation of e-Fixed Deposit"
 * slip (label on one line, value item below it). Run: node test/invest-fd.test.js
 */
var path = require('path');
var FdParse = require(path.join(__dirname, '..', 'investments', 'fd.js'));

var passed = 0, failed = 0;
function eq(name, actual, expected) {
  if (actual === expected) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('FAIL  ' + name + ' — got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)); }
}

/* Synthetic items approximating the clean e-FD slip. */
function eposItems(over) {
  var base = [
    { x: 100, y: 560, str: 'Confirmation of e-Fixed Deposit' },
    { x: 53, y: 590, str: 'Account No.' },
    { x: 160, y: 590, str: 'Customer ID' },
    { x: 280, y: 590, str: 'Customer Name' },
    { x: 53, y: 578, str: '130910DP00004001' },
    { x: 160, y: 578, str: 'T98765432' },
    { x: 285, y: 578, str: 'TEST HOLDER' },
    { x: 94, y: 555, str: 'Deposit Amount' },
    { x: 94, y: 545, str: '₹4,00,000.00' },
    { x: 94, y: 535, str: 'for a period of   444 Days   at the rate of   8.1%   per annum.' },
    { x: 94, y: 527, str: 'Date of Issue' },
    { x: 260, y: 527, str: 'Date of Maturity' },
    { x: 439, y: 526, str: 'Maturity Value' },
    { x: 97, y: 516, str: '10 Mar 2026' },
    { x: 268, y: 516, str: '28 May 2027' },
    { x: 443, y: 516, str: '₹5,10,000.00' },
    { x: 53, y: 480, str: 'Debit Account Number' },
    { x: 160, y: 480, str: 'Repayment Account Number' },
    { x: 160, y: 470, str: '05582191003046' },
    { x: 53, y: 295, str: '3. Maturity Value and part withdrawal if any, are subject to TDS as per Income Tax Act.' }
  ];
  return base.concat(over || []);
}

console.log('parse — clean e-FD slip');
(function () {
  var f = FdParse.parse(eposItems());
  eq('format detected epos', f.format, 'epos');
  eq('account', f.account, '130910DP00004001');
  eq('holder', f.holder, 'TEST HOLDER');
  eq('amount', f.amount, 400000);
  eq('days', f.days, 444);
  eq('rate', f.rate, 8.1);
  eq('issue date', f.issueDate, '2026-03-10');
  eq('maturity date', f.maturityDate, '2027-05-28');
  eq('maturity value', f.maturityValue, 510000);
  eq('repay account', f.repayAc, '05582191003046');
  eq('complete', f.complete, true);
})();

console.log('parse — footnote "Maturity Value…" must not be mistaken for the value cell');
(function () {
  // Ensure the short-table Maturity Value (₹5,10,000.00) wins over the footnote.
  var f = FdParse.parse(eposItems());
  eq('maturity value is the cell, not the footnote', f.maturityValue, 510000);
})();

console.log('parse — legacy / partial slip');
(function () {
  var legacy = [
    { x: 100, y: 560, str: 'CONFIRMATION OF DEPOSIT' },
    { x: 53, y: 578, str: '130910DP00004006' },
    { x: 53, y: 600, str: '₹4,25,000.00' }
  ];
  var f = FdParse.parse(legacy);
  eq('format legacy', f.format, 'legacy');
  eq('account still read', f.account, '130910DP00004006');
  eq('incomplete (no dates)', f.complete, false);
})();

console.log('parse — unknown text');
(function () {
  var f = FdParse.parse([{ x: 0, y: 0, str: 'hello world' }]);
  eq('format unknown', f.format, 'unknown');
  eq('empty account', f.account, '');
  eq('incomplete', f.complete, false);
})();

console.log('isoFromMon / money');
eq('iso single-digit day', FdParse.isoFromMon('5 Mar 2026'), '2026-03-05');
eq('iso double-digit day', FdParse.isoFromMon('28 May 2027'), '2027-05-28');
eq('iso no match', FdParse.isoFromMon('garbage'), null);
eq('money groups', FdParse.money('₹5,10,000.00'), 510000);
eq('money plain', FdParse.money('400000'), 400000);
eq('money null', FdParse.money(null), null);

console.log('parseFilename');
(function () {
  eq('standard name', JSON.stringify(FdParse.parseFilename('Y_PNB_FD_20270528_4001_510000.pdf')),
    JSON.stringify({ maturityDate: '2027-05-28', account: '130910DP4001', maturityValue: 510000 }));
  eq('name with path', FdParse.parseFilename('C:\\x\\Y_PNB_FD_20261230_4002_500000.pdf').maturityDate, '2026-12-30');
  eq('no match', FdParse.parseFilename('random.pdf'), null);
  eq('missing maturity group', FdParse.parseFilename('Y_PNB_FD_20270528_4143.pdf'), null);
})();

console.log('parse — legacy slip filled from file name + derived dates');
(function () {
  var legacy = [
    { x: 100, y: 560, str: 'CONFIRMATION OF DEPOSIT' },
    { x: 83, y: 221, str: '4,00,000.00Rs.' },
    { x: 306, y: 226, str: '390' }, { x: 325, y: 224, str: 'days' },
    { x: 106, y: 106, str: 'ABCDE1234F' }
  ];
  var f = FdParse.parse(legacy, 'Y_PNB_FD_20261230_4002_500000.pdf');
  eq('account from file name', f.account, '130910DP4002');
  eq('maturity date from file name', f.maturityDate, '2026-12-30');
  eq('maturity value from file name', f.maturityValue, 500000);
  eq('amount from lakh figure', f.amount, 400000);
  eq('days read', f.days, 390);
  eq('issue date derived (maturity - 390d)', f.issueDate, '2025-12-05');
  eq('pan read', f.pan, 'ABCDE1234F');
  eq('incomplete (no rate)', f.complete, false);
  eq('fromFile notes present', f.fromFile.indexOf('account') >= 0, true);
})();

console.log('parse — lone amount equal to maturity is not the principal');
(function () {
  var legacy = [
    { x: 100, y: 560, str: 'CONFIRMATION OF DEPOSIT' },
    { x: 83, y: 221, str: '4,35,802.00' } // only figure == maturity value
  ];
  var f = FdParse.parse(legacy, 'Y_PNB_FD_20261001_4007_610000.pdf');
  eq('amount left blank', f.amount, 0);
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
