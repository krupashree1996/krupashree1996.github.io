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

console.log('parse — newer table-layout e-Fixed Deposit slip (headers over values)');
(function () {
  // Mirrors the real Y_PNB_FD_20270315 slip: a header row with the values on the
  // row below, "Consumer Name", and the issue date split across two lines.
  var tbl = [
    { x: 37, y: 710, str: 'Confirmation of e-Fixed Deposit' },
    { x: 43, y: 673, str: 'Account Number :' },
    { x: 310, y: 673, str: '130910TR00000009' },
    { x: 43, y: 620, str: 'Consumer Name :' },
    { x: 310, y: 620, str: 'TEST HOLDER' },
    { x: 43, y: 515, str: 'Repayment Account Number :' },
    { x: 310, y: 515, str: '01652191003903' },
    // header row
    { x: 65, y: 473, str: 'Deposit' }, { x: 65, y: 459, str: 'Amount' },
    { x: 149, y: 466, str: 'Tenure' },
    { x: 228, y: 473, str: 'Fixed Rate' }, { x: 235, y: 459, str: 'Interest' },
    { x: 330, y: 473, str: 'Date of' }, { x: 334, y: 459, str: 'Issue' },
    { x: 416, y: 473, str: 'Date Of' }, { x: 414, y: 459, str: 'Maturity' },
    { x: 507, y: 473, str: 'Maturity' }, { x: 514, y: 459, str: 'Value' },
    // value row
    { x: 57, y: 425, str: '₹' }, { x: 63, y: 425, str: '35,000.00' },
    { x: 148, y: 418, str: 'Months' }, { x: 161, y: 432, str: '60' },
    { x: 240, y: 425, str: '5.25%' },
    { x: 330, y: 432, str: '15 Mar' }, { x: 335, y: 418, str: '2022' },
    { x: 403, y: 425, str: '15 Mar 2027' },
    { x: 500, y: 425, str: '₹' }, { x: 506, y: 425, str: '52,000.00' },
    // noise below the value band that must NOT be picked up
    { x: 37, y: 384, str: 'This is a computer generated con' },
    { x: 362, y: 418, str: '15 Mar 2027' }
  ];
  var f = FdParse.parse(tbl, 'Y_PNB_FD_20270315_0009_52000.pdf');
  eq('format epos (split title)', f.format, 'epos');
  eq('account', f.account, '130910TR00000009');
  eq('holder (Consumer Name)', f.holder, 'TEST HOLDER');
  eq('amount', f.amount, 35000);
  eq('days (60 months -> 1800)', f.days, 1800);
  eq('rate', f.rate, 5.25);
  eq('issue date (split lines)', f.issueDate, '2022-03-15');
  eq('maturity date', f.maturityDate, '2027-03-15');
  eq('maturity value', f.maturityValue, 52000);
  eq('repay account', f.repayAc, '01652191003903');
  eq('complete (auto-import path)', f.complete, true);
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

console.log('parsePdf — page loop reads every page (regression: var-in-async-loop)');
(function () {
  // Mock pdfjsLib so we exercise the real page-loop closure without a PDF worker.
  // Each page yields a distinct item; the loop must fetch pages 1..N in order.
  function mockPdfjs(numPages, itemsPerPage) {
    return {
      GlobalWorkerOptions: {},
      getDocument: function () {
        return {
          promise: Promise.resolve({
            numPages: numPages,
            getPage: function (n) {
              if (!Number.isInteger(n) || n <= 0 || n > numPages) {
                return Promise.reject(new Error('Invalid page request.'));
              }
              return Promise.resolve({
                getTextContent: function () { return Promise.resolve({ items: itemsPerPage[n - 1] }); }
              });
            }
          })
        };
      }
    };
  }
  var items = [
    [
      { transform: [1, 0, 0, 1, 100, 560], str: 'Confirmation of e-Fixed Deposit' },
      { transform: [1, 0, 0, 1, 94, 535], str: 'Deposit Amount' },
      { transform: [1, 0, 0, 1, 94, 525], str: '₹4,00,000.00' }
    ],
    [{ transform: [1, 0, 0, 1, 0, 0], str: 'page two marker' }]
  ];
  FdParse.parsePdf(new Uint8Array([]), mockPdfjs(2, items), 'Y_PNB_FD_20270528_4001_510000.pdf').then(function (f) {
    eq('parsed without Invalid page request', f.amount, 400000);
    eq('account from file name', f.account, '130910DP4001');
    done();
  }).catch(function (e) {
    failed++;
    console.log('FAIL  parsePdf threw — ' + e.message);
    done();
  });
})();

function done() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}
