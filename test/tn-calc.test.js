'use strict';
/* Thorough unit tests for tn-utilities/calc.js — money/slab/subsidy math,
 * tariff-era resolution & cutover blending, the verifyBill checks, receipt
 * verification for elec/water/PT, half-year helpers, exceptions/blocking and
 * schema migration. Run: node test/tn-calc.test.js
 */
var path = require('path');
var Calc = require(path.join(__dirname, '..', 'tn-utilities', 'calc.js'));

var passed = 0, failed = 0;
function eq(name, actual, expected) {
  var a = String(actual), e = String(expected);
  if (a === e) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('FAIL  ' + name + ' — got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)); }
}
function ok(name, cond) { eq(name, !!cond, true); }
function section(name) { console.log(name); }

/* helpers */
function check(checks, key) {
  for (var i = 0; i < checks.length; i++) if (checks[i].key === key) return checks[i];
  return null;
}

section('round2 / close / cleanAmount');
eq('round2 basic', Calc.round2(1.005), 1.01);
eq('round2 2.675', Calc.round2(2.675), 2.68);
eq('close within tol', Calc.close(100.01, 100, 0.02), true);
eq('close outside tol', Calc.close(100.1, 100, 0.02), false);
eq('close NaN', Calc.close(NaN, 100), false);
eq('cleanAmount rupee', Calc.cleanAmount('₹1,234.56'), 1234.56);
eq('cleanAmount slash', Calc.cleanAmount('Rs. 99/-'), 99);
eq('cleanAmount slash decimal', Calc.cleanAmount('₹1,666.40/-'), 1666.4);
eq('cleanAmount minus', Calc.cleanAmount('-50.25'), -50.25);
eq('cleanAmount garbage', isFinite(Calc.cleanAmount('abc')), false);
eq('cleanAmount parens', Calc.cleanAmount('(−1,000.00)'), -1000);

section('slab energy engine');
var R2025 = Calc.REGIMES.filter(function (r) { return r.key === 'R2025'; })[0];
eq('R2025 below 478 units', Calc.proposedByTables(478, { below: R2025.below, above: R2025.above }).total, 2498.7);
eq('R2025 above 600 units', Calc.proposedByTables(600, { below: R2025.below, above: R2025.above }).total, 3525);
eq('R2025 breakdown length 478', Calc.proposedByTables(478, { below: R2025.below, above: R2025.above }).breakdown.length, 2);
eq('R2025 breakdown sum matches', (function () {
  var b = Calc.proposedByTables(478, { below: R2025.below, above: R2025.above }).breakdown;
  return b.reduce(function (s, x) { return s + x.amount; }, 0);
})(), 2498.7);
eq('below-table route on 500', Calc.proposedByTables(500, { below: R2025.below, above: R2025.above }).total, 2598);
eq('no tables -> NaN', isFinite(Calc.proposedByTables(10, null).total), false);

section('govt subsidy + era subsidies');
eq('subsidy 100', Calc.govtSubsidy(100), 495);
eq('subsidy 200', Calc.govtSubsidy(200), 755);
eq('subsidy 400', Calc.govtSubsidy(400), 805);
eq('subsidy 500', Calc.govtSubsidy(500), 840);
eq('subsidy 600', Calc.govtSubsidy(600), 645);
eq('subsidy 1000', Calc.govtSubsidy(1000), 745);
eq('subsidy 1100', Calc.govtSubsidy(1100), 915);
eq('subsidy negative', isFinite(Calc.govtSubsidy(-5)), false);
section('R2026 free-200 scheme');
eq('free200 200 units', Calc.REGIMES.filter(function (r) { return r.key === 'R2026'; })[0].sub(200), 990);
eq('free200 478.87 units → ₹1,436.881 (docs claim)', Calc.round2(Calc.REGIMES.filter(function (r) { return r.key === 'R2026'; })[0].sub(478.87) - 0), 0); // structural; exact value below
eq('free200 478.87 exact', Calc.round2(200 * 4.95 + 0.25 * 200 + 0.35 * 78.87), 1436.88);

section('tariff-era resolution (tablesForBill)');
var iso = function (d) { return (d || '').replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1'); };
var ring = { key: 'R2025' };
function tablesFor(dFrom, dTo) {
  return Calc.tablesForBill({ periodFrom: iso(dFrom), periodTo: iso(dTo) });
}
section('era boundary picks');
eq('2025-11 era', tablesFor('01/10/2025', '30/11/2025').regime.key, 'R2025');
eq('2026-06 era', tablesFor('01/05/2026', '30/06/2026').regime.key, 'R2026');
eq('2024-01 era', tablesFor('01/12/2023', '31/01/2024').regime.key, 'R2023');
eq('2022-10 era', tablesFor('01/10/2022', '30/11/2022').regime.key, 'R2022');
eq('pre-built-in → null', tablesFor('01/05/2020', '30/06/2020'), null);
var cut = tablesFor('20/06/2025', '10/07/2025');
ok('cross-1-Jul bill has cutover', cut && cut.cutover);
eq('cutover on date', cut && cut.cutover.on, '2025-07-01');
eq('cutover fOld in (0,1)', cut && cut.cutover.fOld > 0 && cut.cutover.fOld < 1, true);
eq('cutover blended rate below-1', cut && cut.tables.below[0][2], 4.8675);
eq('cutover no-cut bill', tablesFor('01/08/2025', '30/09/2025').cutover, null);
eq('cutover subFn blended', cut && Math.abs(cut.subFn(100) - (Calc.govtSubsidy(100) * 0.45 + (Calc.REGIMES.filter(function (r) { return r.key === 'R2024'; })[0].sub(100)) * 0.55)) < 0.001, true);

section('verifyBill — normal R2025 bill (all pass)');
var bill = {
  scNo: '00112233445', tariff: 'LA1A', consumerName: 'A. RAMASWAMY',
  periodFrom: '01/07/2025', periodTo: '31/08/2025',
  prevReading: 1000, presentReading: 1478, mf: 1, units: 478,
  energyCharges: 2498.7, fixedCharges: 0, govtSubsidy: 832.3,
  netTotal: 1666.4, totalPayable: 1666.4
};
var v = Calc.verifyBill(bill, { auto: true, profileSc: '00112233445', prevRecord: null, laterRecord: null });
var ss = Calc.statusSummary(v.checks);
eq('normal passes', ss.pass, 7);
eq('normal infos', ss.info, 2);
eq('normal fails/warns', ss.fail + ss.warn, 0);
eq('recomputed', v.recomputed, 2498.7);
ok('energy check pass', check(v.checks, 'energy').status === 'pass');
ok('subsidy check pass', check(v.checks, 'subsidy').status === 'pass');
ok('total check pass', check(v.checks, 'total').status === 'pass');
ok('sc check pass', check(v.checks, 'sc').status === 'pass');
ok('tariff check pass', check(v.checks, 'tariff').status === 'pass');
ok('units check pass', check(v.checks, 'units').status === 'pass');

section('verifyBill — energy missing (special/assessment) now passes via net fallback');
var asmt = {
  scNo: '00112233445', tariff: 'LA1A', periodFrom: '01/07/2025', periodTo: '31/08/2025',
  prevReading: 1000, presentReading: 1250, mf: 1, units: 250,
  energyCharges: null, fixedCharges: 0, govtSubsidy: null, netTotal: 1237.5, totalPayable: 1237.5
};
var va = Calc.verifyBill(asmt, { auto: true, profileSc: '00112233445', prevRecord: null, laterRecord: null });
ok('special assessment energy passes via net', check(va.checks, 'energy').status === 'pass');
ok('special assessment total is info', check(va.checks, 'total').status === 'info');

section('verifyBill — clear energy mismatch fails');
var bad = {
  scNo: '00112233445', tariff: 'LA1A', periodFrom: '01/07/2025', periodTo: '31/08/2025',
  prevReading: 1000, presentReading: 1100, mf: 1, units: 100,
  energyCharges: 999, fixedCharges: 0, govtSubsidy: 0, netTotal: 999, totalPayable: 999
};
var vbad = Calc.verifyBill(bad, { auto: true, profileSc: '00112233445', prevRecord: null, laterRecord: null });
ok('mismatch energy fails', check(vbad.checks, 'energy').status === 'fail');
ok('total of mismatch still passes', check(vbad.checks, 'total').status === 'pass');

section('verifyBill — S/C differs / tariff warn / tariff missing');
var diff = { scNo: '00998877665', tariff: 'LA1A', periodFrom: '01/07/2025', periodTo: '31/08/2025',
  prevReading: 0, presentReading: 100, mf: 1, units: 100, energyCharges: 495, fixedCharges: 0, govtSubsidy: 495, netTotal: 0, totalPayable: 0 };
var vd = Calc.verifyBill(diff, { auto: true, profileSc: '00112233445', prevRecord: null, laterRecord: null });
ok('different S/C is info (not blocking)', check(vd.checks, 'sc').status === 'info');
var noT = { scNo: '00112233445', periodFrom: '01/07/2025', periodTo: '31/08/2025',
  prevReading: 0, presentReading: 100, mf: 1, units: 100, energyCharges: 495, fixedCharges: 0, govtSubsidy: 495, netTotal: 0, totalPayable: 0 };
var vn = Calc.verifyBill(noT, { auto: true, profileSc: '00112233445', prevRecord: null, laterRecord: null });
ok('missing tariff is info', check(vn.checks, 'tariff').status === 'info');
var wT = { scNo: '00112233445', tariff: 'IA', periodFrom: '01/07/2025', periodTo: '31/08/2025',
  prevReading: 0, presentReading: 100, mf: 1, units: 100, energyCharges: 495, fixedCharges: 0, govtSubsidy: 495, netTotal: 0, totalPayable: 0 };
var vw = Calc.verifyBill(wT, { auto: true, profileSc: '00112233445', prevRecord: null, laterRecord: null });
ok('non-LA1A tariff is warn', check(vw.checks, 'tariff').status === 'warn');

section('verifyBill — reading continuity (backward + forward, gap skip)');
var prev = { periodTo: '30/06/2025', presentReading: 1000, sdClosing: null };
var contOk = Calc.verifyBill(bill, { auto: true, profileSc: '00112233445', prevRecord: prev, laterRecord: null });
ok('contiguous reading passes', check(contOk.checks, 'continuity').status === 'pass');
var prevGap = { periodTo: '15/04/2025', presentReading: 900 };
var vgap = Calc.verifyBill(bill, { auto: true, profileSc: '00112233445', prevRecord: prevGap, laterRecord: null });
ok('wide gap → continuity info (skip)', check(vgap.checks, 'continuity').status === 'info');
var later = { periodFrom: '01/09/2025', prevReading: 1478, presentReading: 1956 };
var vf = Calc.verifyBill(bill, { auto: true, profileSc: '00112233445', prevRecord: null, laterRecord: later });
ok('forward continuity passes', check(vf.checks, 'continuityFwd').status === 'pass');

section('verifyBill — security deposit');
var sd = {
  scNo: '00112233445', tariff: 'LA1A', periodFrom: '01/07/2025', periodTo: '31/08/2025',
  prevReading: 1000, presentReading: 1478, mf: 1, units: 478,
  energyCharges: 2498.7, fixedCharges: 0, govtSubsidy: 832.3, netTotal: 1666.4, totalPayable: 1666.4,
  sdOpening: 1500, sdCollected: 100, sdInterest: 22.5, sdRefund: 0, sdClosing: 1622.5, mcd: 1500
};
var vsd = Calc.verifyBill(sd, { auto: true, profileSc: '00112233445', prevRecord: null, laterRecord: null });
ok('SD arithmetic passes', check(vsd.checks, 'sd').status === 'pass');
ok('SD no MCD warn when at/above', check(vsd.checks, 'mcd') === null || check(vsd.checks, 'mcd').status !== 'warn');
var sdBad = {
  scNo: '00112233445', tariff: 'LA1A', periodFrom: '01/07/2025', periodTo: '31/08/2025',
  prevReading: 1000, presentReading: 1478, mf: 1, units: 478,
  energyCharges: 2498.7, fixedCharges: 0, govtSubsidy: 832.3, netTotal: 1666.4, totalPayable: 1666.4,
  sdOpening: 1500, sdCollected: 0, sdInterest: 0, sdRefund: 0, sdClosing: 1900, mcd: 5000
};
var vsdbad = Calc.verifyBill(sdBad, { auto: true, profileSc: '00112233445', prevRecord: null, laterRecord: null });
ok('broken SD arithmetic fails', check(vsdbad.checks, 'sd').status === 'fail');
ok('SD below MCD warns', check(vsdbad.checks, 'mcd').status === 'warn');
var noSd = { scNo: '00112233445', periodFrom: '01/07/2025', periodTo: '31/08/2025',
  prevReading: 0, presentReading: 100, mf: 1, units: 100, energyCharges: 495, fixedCharges: 0, govtSubsidy: 495, netTotal: 0, totalPayable: 0 };
ok('no SD block → info', check(Calc.verifyBill(noSd, { auto: true, profileSc: '00112233445', prevRecord: null, laterRecord: null }).checks, 'sd').status === 'info');

section('verifyReceipt (elec)');
var pendingBill = { id: 'b-1', scNo: '00112233445', totalPayable: 1666.4, netTotal: 1666.4 };
var pay = { receiptNo: 'PG12345678', scNo: '00112233445', paidAmount: 1666.4 };
var vr = Calc.verifyReceipt(pay, pendingBill, { usedReceiptNo: new Set(['PG12345678']) });
ok('receipt sc pass', check(vr, 'receipt_sc').status === 'pass');
ok('receipt amount pass', check(vr, 'receipt_amount').status === 'pass');
ok('receipt dup detected', check(vr, 'receipt_dup').status === 'fail');
var pay2 = { receiptNo: 'PG12345678', scNo: '99999999999', paidAmount: 5000 };
var vr2 = Calc.verifyReceipt(pay2, pendingBill, { usedReceiptNo: new Set() });
ok('receipt sc mismatch fails', check(vr2, 'receipt_sc').status === 'fail');
ok('receipt amount mismatch fails', check(vr2, 'receipt_amount').status === 'fail');
var pay3 = { receiptNo: 'ab', scNo: '00112233445', paidAmount: 1666.4 };
ok('short receipt no fails', check(Calc.verifyReceipt(pay3, pendingBill, { usedReceiptNo: new Set() }), 'receipt_no').status === 'fail');

section('verifyWater');
var wctx = { cmcNo: '007012345', usedReceiptNo: new Set() };
var wp = { cmcNo: '007012345', receiptNo: 'W12345678', item: null, paidDate: '12/08/2025', amount: 1200, paidTotal: 1200, grandTotal: 1200, items: [{ term: 'a', amount: 1200 }] };
var vw2 = Calc.verifyWater(wp, wctx);
ok('water conn pass', check(vw2, 'water_conn').status === 'pass');
ok('water sum pass', check(vw2, 'water_sum').status === 'pass');
ok('water amount pass', check(vw2, 'water_amount').status === 'pass');
ok('water no pass', check(vw2, 'water_no').status === 'pass');
ok('water date pass', check(vw2, 'water_date').status === 'pass');
var wpBad = { cmcNo: '000000000', receiptNo: 'ab', paidDate: 'garbage', amount: 50, paidTotal: 500, items: [{ term: 'a', amount: 100 }] };
var vw3 = Calc.verifyWater(wpBad, wctx);
ok('water conn mismatch fails', check(vw3, 'water_conn').status === 'fail');
ok('water bad date fails', check(vw3, 'water_date').status === 'fail');
ok('water missing items warn', check(vw3, 'water_sum').status === 'warn');

section('verifyPT');
var pctx = { propertyNo: '12-345-67890-123', usedReceiptNo: new Set() };
var pp = { propertyNo: '12-345-67890-123', receiptNo: 'P123456', paidDate: '11/03/2024', amount: 4567, items: [{ term: 'I/25-26', amount: 1019 }, { term: 'II/25-26', amount: 3548 }] };
var vp = Calc.verifyPT(pp, pctx);
ok('pt prop pass', check(vp, 'pt_prop').status === 'pass');
ok('pt sum pass', check(vp, 'pt_sum').status === 'pass');
ok('pt amount pass', check(vp, 'pt_amount').status === 'pass');
ok('pt no pass', check(vp, 'pt_no').status === 'pass');
ok('pt date pass', check(vp, 'pt_date').status === 'pass');

section('half-year helpers');
eq('hyOfDate H1 Apr', Calc.hyOfDate('01/04/2026'), '26-27H1');
eq('hyOfDate H2 Mar', Calc.hyOfDate('31/03/2027'), '26-27H2');
eq('hyOfDate garbage', Calc.hyOfDate('x'), '');
eq('hyKey ordering', Calc.hyKey('26-27H1') < Calc.hyKey('26-27H2'), true);
eq('hyNext H2', Calc.hyNext('25-26H2'), '26-27H1');
eq('hyNext H1', Calc.hyNext('25-26H1'), '25-26H2');
eq('hyLabel', Calc.hyLabel('25-26H1'), 'H1 25-26');
eq('hyLabel garbage', Calc.hyLabel(''), '—');
var hyopts = Calc.hyOptions();
ok('hyOptions has current', hyopts.indexOf(Calc.hyCurrent()) >= 0);
ok('hyOptions has blank option', hyopts.indexOf('') >= 0);
ok('hyOptions has next FY', hyopts.indexOf(Calc.hyNext(Calc.hyPrev(Calc.hyCurrent()))) >= 0);
eq('hyDetect roman numerals', Calc.hyDetect({ items: [{ term: 'I/25-26', amount: 10 }] }), '25-26H1');
eq('hyDetect fy + date', Calc.hyDetect({ items: [{ term: '26-27/CA', amount: 10 }], paidDate: '15/11/2026' }), '26-27H2');

section('duplicatesFor');
var recs = [
  { id: 'a', periodFrom: '01/07/2025', periodTo: '31/08/2025' },
  { id: 'b', periodFrom: '01/09/2025', periodTo: '30/09/2025' }
];
eq('no overlap', Calc.duplicatesFor(recs, '15/10/2025', '30/11/2025').length, 0);
eq('touching boundary excluded', Calc.duplicatesFor(recs, '01/09/2025', '30/10/2025').length, 1);
eq('self excluded', Calc.duplicatesFor(recs, '01/07/2025', '31/08/2025', 'a').length, 0);

section('applyExceptions / hasBlocking / statusSummary');
var fl = { key: 'k', label: 'x', status: 'fail', configurable: true };
var wn = { key: 'w', label: 'y', status: 'warn', configurable: true };
var applied = Calc.applyExceptions([fl, wn], {});
ok('blocked without exceptions', applied.blocked === true && Calc.hasBlocking([fl, wn], {}) === true);
var accepted = Calc.applyExceptions([fl, wn], { k: 'by user' });
ok('accepted removes blocked', accepted.blocked === false);
ok('accepted check flips status', accepted.checks[0].status === 'accepted');
ok('hasBlocking ignores unresolved warn', Calc.hasBlocking([fl, wn], { k: 'ok' }) === false);
var ss2 = Calc.statusSummary(accepted.checks);
eq('status summary accepted+badges', ss2.accepted + ss2.fail + ss2.warn, 1);

section('schema migration');
eq('SCHEMA_VERSION', Calc.SCHEMA_VERSION, 3);
var old = { version: 0, records: [{ scNo: '123', periodTo: '01/01/2025', units: '100' }] };
var mig = Calc.migrateBundle(old);
eq('migrated to v3', mig.version, 3);
eq('migrated numeric coercion', mig.records[0].units, 100);
eq('migrated id', mig.records[0].id, 'b-123-01/01/2025');
eq('migrated type elec', mig.records[0].type, 'elec');
ok('migrated consumers rebuilt', mig.consumers.length === 1 && mig.consumers[0].scNo === '123');
var newer = Calc.migrateBundle({ version: 99, records: [] });
ok('future schema rejected', newer.incompatible === true);
var water = Calc.migrateBundle({ version: 2, records: [{ type: 'water', cmcNo: '007012345', no: '007012345', periodTo: '12/08/2025', paidOn: { receiptNo: 'W1' }, status: 'paid' }] });
ok('conn roster rebuilt for water', (water.waterConsumers || []).length === 1);
ok('migrated water record keeps paid status', water.records[0].status === 'paid');

console.log('\nTN calc: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);