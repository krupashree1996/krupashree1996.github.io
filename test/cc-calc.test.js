'use strict';
/* Unit tests for neu-tracker/ (HDFC Tata Neu Credit Card Tracker):
 * MAD formula, statement parser (old + new layouts), verification checks,
 * ledger coin prediction, reconciliation engine, schema migration and a
 * privacy guard that proves the committed app contains no personal data.
 * Run: node test/cc-calc.test.js
 */
var path = require('path');
var fs = require('fs');
var Calc = require(path.join(__dirname, '..', 'neu-tracker', 'calc.js'));
var Parser = require(path.join(__dirname, '..', 'neu-tracker', 'parser.js'));

var passed = 0, failed = 0;
function eq(name, actual, expected) {
  var a = String(actual), e = String(expected);
  if (a === e) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('FAIL  ' + name + ' — got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)); }
}
function ok(name, cond) { eq(name, !!cond, true); }
function section(name) { console.log(name); }
function check(checks, key) { for (var i = 0; i < checks.length; i++) if (checks[i].key === key) return checks[i]; return null; }

/* Turn lines into a pdf.js-like textContent that groupLines() reconstructs. */
function tcOf(lines) {
  var items = [], y = 1000;
  lines.forEach(function (ln) {
    var x = 0;
    String(ln).split(' ').forEach(function (t) {
      items.push({ str: t, transform: [1, 0, 0, 1, x, y], width: t.length * 4 });
      x += t.length * 4 + 4;
    });
    y -= 12;
  });
  return { items: items };
}
function parse(lines) { return Parser.parseStatement(tcOf(lines)); }

/* ------------------------------------------------------------------ */
section('cleanAmount / round2 / close');
eq('cleanAmount rupee', Calc.cleanAmount('₹1,234.56'), 1234.56);
eq('cleanAmount C prefix', Calc.cleanAmount('C21,266.30'), 21266.3);
eq('cleanAmount plain', Calc.cleanAmount('16,554.31'), 16554.31);
eq('cleanAmount integer', Calc.cleanAmount('5,00,000'), 500000);
eq('cleanAmount garbage', isFinite(Calc.cleanAmount('abc')), false);
eq('round2', Calc.round2(9012.145), 9012.15);
ok('close within tol', Calc.close(16.99164, 16.992, 0.02));

section('MAD formula — verified against real statements');
eq('202503  16,992 → 850', Calc.madFor(16992), 850);
eq('20251118 21,267 → 1,070', Calc.madFor(21267), 1070);
eq('20251019 16,554 → 830', Calc.madFor(16554), 830);
eq('20251219 74,343 → 3,720', Calc.madFor(74343), 3720);
eq('20250918 238,844 → 11,950', Calc.madFor(238844), 11950);
eq('24024 → 1,210 (20260119)', Calc.madFor(24024), 1210);
eq('20260119 14,678 → 740', Calc.madFor(14678), 740);
eq('20260319 14,833 → 750', Calc.madFor(14833), 750);
eq('20260419 315,764 → 15,790', Calc.madFor(315764), 15790);
eq('20260519 172,061 → 8,610', Calc.madFor(172061), 8610);
eq('20260619 63,664 → 3,190', Calc.madFor(63664), 3190);
eq('20260720 219,972 → 11,000', Calc.madFor(219972), 11000);
eq('20260819 17,755 → 890', Calc.madFor(17755), 890);
eq('20250419 107,330 → 5,370', Calc.madFor(107330), 5370);
eq('20250819  74,343 → 3,720', Calc.madFor(74343), 3720);
eq('ceil-to-10 boundary 1000 → 50', Calc.madFor(1000), 50);
eq('ceil-to-10 boundary 1001 → 60', Calc.madFor(1001), 60);
eq('ceil-to-10 boundary 2000 → 100', Calc.madFor(2000), 100);
eq('NaN total → NaN', isFinite(Calc.madFor(NaN)), false);

section('real account-summary math (202503)');
eq('balance 24490.71 + 46239.78 − 53738.85 = 16991.64 (bank shows 16,992)', Calc.round2(24490.71 + 46239.78 - 53738.85), 16991.64);
ok('delta vs printed total 0.36', Math.abs(Math.abs(Calc.round2(24490.71 + 46239.78 - 53738.85) - 16992) - 0.36) < 1e-9);

/* ------------------------------------------------------------------ */
section('parser — old layout (self-consistent sample)');
var OLD_LINES = [
  'Statement for HDFC Bank Credit Card',
  'Statement Date:18/03/2025',
  'Card Member Since: 2021',
  'Payment Due Date Total Dues Minimum Amount Due',
  '07/04/2025 9,012.15 460.00',
  'Account Summary',
  'Balance Credits Debits Charges Total Dues',
  '31,546.00 30,178.85 7,645.00 0.00 9,012.15',
  'Credit Limit Available Credit Available Cash',
  '₹5,00,000 ₹4,90,987.85 ₹2,00,000',
  'Transactions',
  '31/01/2025 18:54:22 UPI-MyGate 240.00',
  '05/02/2025 12:11:47 TATAPAYMENTSLIMITEGURGOAN 620.00',
  '10/02/2025 09:30:15 SRI KRISHNA SWEETS VADACHENNAI 785.00',
  '24/02/2025 11:02:17 PINK 90 6,000.00',
  '28/02/2025 14:20:38 TELE TRANSFER CREDIT 1,230.00 Cr',
  '05/03/2025 08:12:03 NETBANKING TRANSFER 28,948.85 Cr',
  'NeuCoins Summary',
  'Opening NeuCoins with Bank Total NeuCoins Earned (Base + Bonus) NeuCoins transferred to Tata Neu Adjusted/Lapsed Closing NeuCoins with Bank',
  '321 1,659 321 0 1,659',
  'Bonus NeuCoins Summary',
  'Sr No. Programs Bonus NeuCoins',
  '1 NeuCoins_on_EMI 416',
  '2 Base_Grocery 302',
  '3 NeuCoins_on_UPI_Acc 148',
  'Card Number 1234 56XX XXXX 7890'
];
var old = parse(OLD_LINES);
eq('old layout detected', old.layout, 'old');
eq('old statement date', old.statementDate, '18/03/2025');
eq('old due date', old.dueDate, '07/04/2025');
eq('old total', old.total, 9012.15);
eq('old minimum due', old.minimumDue, 460);
eq('old prev dues (opening)', old.prevDues, 31546);
eq('old payments', old.payments, 30178.85);
eq('old purchases', old.purchases, 7645);
eq('old finance', old.finance, 0);
eq('old credit limit', old.creditLimit, 500000);
eq('old available credit', old.availLimit, 490987.85);
eq('old closing NeuCoins', old.closingNeuCoins, 1659);
eq('old earned NeuCoins', old.earnedNeuCoins, 1659);
eq('old opened NeuCoins', old.openingNeuCoins, 321);
eq('old bonus total', old.bonusTotal, 866);
eq('old card no', old.cardNo, '123456XXXXXX7890');
ok('old card no is masked', /X{4}/.test(old.cardNo));
eq('old txn count', old.txns.length, 6);
eq('UPI row is debit', old.txns[0].credit, false);
ok('TATAPAYMENT… (merchant name) treated as debit', old.txns[1].credit === false && old.txns[1].desc === 'TATAPAYMENTSLIMITEGURGOAN');
eq('grocery desc kept whole', old.txns[2].desc, 'SRI KRISHNA SWEETS VADACHENNAI');
eq('PINK base coins parsed', old.txns[3].base, 90);
eq('PINK amount', old.txns[3].amount, 6000);
eq('TELE TRANSFER credit', old.txns[4].credit, true);
eq('NETBANKING credit', old.txns[5].credit, true);
eq('NETBANKING amount', old.txns[5].amount, 28948.85);
eq('debit sum', old.txns.filter(function (t) { return !t.credit; }).reduce(function (s, t) { return s + t.amount; }, 0), 7645);
eq('credit sum', old.txns.filter(function (t) { return t.credit; }).reduce(function (s, t) { return s + t.amount; }, 0), 30178.85);

section('parser — new layout (self-consistent sample)');
var NEW_LINES = [
  'Tata Neu Infinity HDFC Bank Credit Card Statement',
  'Card Member Since: CARDHOLDER NAME 2021',
  'TOTAL AMOUNT DUE',
  'C8,256.61',
  'MINIMUM DUE',
  'C420.00',
  'DUE DATE',
  '08 Dec, 2025',
  'Statement Date',
  '18 Nov, 2025',
  'Billing Period',
  '19 Oct, 2025 - 18 Nov, 2025',
  'PREVIOUS STATEMENT DUES PAYMENTS/CREDITS RECEIVED PURCHASES/DEBIT (Current Billing Cycle) FINANCE CHARGES',
  'C16,554.31 C16,554.00 C8,256.30 C0.00',
  'CREDIT LIMIT AVAILABLE CREDIT AVAILABLE CASH',
  'C5,00,000 C4,90,743.39 C2,00,000',
  '18/10/2025 21:02 JALPAAN 746.00',
  '19/10/2025 09:14 PINK 90 6,000.00',
  '23/10/2025 18:40 BPPY CC PAYMENT + C 16,554.00',
  '28/10/2025 13:22 SRI KRISHNA SWEETS VADACHENNAI C 785.00',
  '02/11/2025 10:12 ASTROTALK PI C 590.00',
  '05/11/2025 07:47 UPI-Mavubasha-Coffee 135.30',
  'Opening NeuCoins with Bank NeuCoins Earned (Base + Bonus) NeuCoins Transferred to Tata Neu Adjusted/Lapsed',
  '167 475 167 0',
  'Closing NeuCoins with Bank',
  '475',
  'Bonus NeuCoins Summary',
  'SR NO. PROGRAMS Bonus NeuCoins',
  '1 Add_TataPayment 208',
  '2 Base_Grocery 77',
  '3 NeuCoins_on_UPI_Acc 48',
  '4 NeuCoins_on_EMI 75',
  'Total 408',
  'AAN 0000000000000000001'
];
var nw = parse(NEW_LINES);
eq('new layout detected', nw.layout, 'new');
eq('new statement date', nw.statementDate, '18/11/2025');
eq('new period from', nw.periodFrom, '19/10/2025');
eq('new period to', nw.periodTo, '18/11/2025');
eq('new due date', nw.dueDate, '08/12/2025');
eq('new total', nw.total, 8256.61);
eq('new minimum due', nw.minimumDue, 420);
eq('new prev dues', nw.prevDues, 16554.31);
eq('new payments', nw.payments, 16554);
eq('new purchases', nw.purchases, 8256.3);
eq('new finance', nw.finance, 0);
eq('new available credit', nw.availLimit, 490743.39);
eq('new closing NeuCoins', nw.closingNeuCoins, 475);
eq('new bonus total', nw.bonusTotal, 408);
eq('new bonus programs count', nw.bonusPrograms.length, 4);
eq('new txn count', nw.txns.length, 6);
eq('new debit sum', nw.txns.filter(function (t) { return !t.credit; }).reduce(function (s, t) { return s + t.amount; }, 0), 8256.3);
eq('new credit rows parsed', nw.txns.filter(function (t) { return t.credit; }).length, 1);
eq('BPPY payment + credit', nw.txns[2].credit, true);
eq('BPPY desc clean', nw.txns[2].desc, 'BPPY CC PAYMENT');
eq('ASTROTALK not credit despite C prefix', nw.txns[4].credit, false);
eq('PINK base parsed (new)', nw.txns[1].base, 90);
eq('normDate textual', Parser.normDate('18 Nov, 2025'), '18/11/2025');
 eq('normDate slash', Parser.normDate('18/11/2025'), '18/11/2025');
 /* no-time rows (EMI/fee/loan-prepay/AGGREGATOREMI) must parse, not be dropped */
 var nt = Parser.parseTxnLine('18/02/2025 AGGREGATOREMI -OFFUS CREDIT (Ref# 09999999980218000651934) - 416 27,709.10 Cr');
 ok('no-time row parsed', !!nt);
 eq('no-time credit flag', nt.credit, true);
 eq('no-time amount', nt.amount, 27709.10);
 eq('no-time base', nt.base, 416);
 eq('no-time time default', nt.time, '00:00');
 var nt2 = Parser.parseTxnLine('10/03/2025 OFFUS EMI,LOAN PRECL,00000120112346 (Ref# 09999999980310000210652) 27,709.10');
 ok('no-time debit row parsed', !!nt2);
 eq('no-time debit flag', nt2.credit, false);
 eq('no-time debit amount', nt2.amount, 27709.10);
 /* '+ C <amount>' credit (description wrapped to the prior line) must be a credit */
 var wc = Parser.parseTxnLine('19/01/2026 12:53 + C 1,210.00');
 ok('wrapped +C credit parsed', !!wc);
 eq('wrapped +C is credit', wc.credit, true);
 eq('wrapped +C amount', wc.amount, 1210.00);
 var wc2 = Parser.parseTxnLine('17/06/2026 13:18 PETRO SURCHARGE WAIVER + C 8.68');
 eq('waiver +C is credit', wc2.credit, true);
 eq('waiver +C amount', wc2.amount, 8.68);

/* ------------------------------------------------------------------ */
section('verifyStatement — old layout (all pass)');
var vOld = Calc.verifyStatement(old, { prevRecord: { periodTo: '17/02/2025', closingNeuCoins: 321 }, cardNo: '' });
var ssOld = Calc.statusSummary(vOld.checks);
eq('old passes', ssOld.pass, 9);
eq('old infos', ssOld.info, 1);
eq('old fails/warns', ssOld.fail + ssOld.warn, 0);
ok('old mad passes', check(vOld.checks, 'mad').status === 'pass');
ok('old purchases passes', check(vOld.checks, 'purchases').status === 'pass');
ok('old payments passes', check(vOld.checks, 'payments').status === 'pass');
ok('old balance passes', check(vOld.checks, 'balance').status === 'pass');
ok('old coins passes', check(vOld.checks, 'coins').status === 'pass');
ok('old coins_prev passes', check(vOld.checks, 'coins_prev').status === 'pass');
ok('old limit passes', check(vOld.checks, 'limit').status === 'pass');

section('verifyStatement — new layout (all pass)');
var vNew = Calc.verifyStatement(nw, { prevRecord: { periodTo: '18/10/2025', closingNeuCoins: 167 }, cardNo: '' });
var ssNew = Calc.statusSummary(vNew.checks);
eq('new passes', ssNew.pass, 9);
eq('new infos', ssNew.info, 1);
eq('new fails/warns', ssNew.fail + ssNew.warn, 0);
ok('new balance delta small', Math.abs(check(vNew.checks, 'balance').delta) <= 0.4, true);
eq('new bal delta', check(vNew.checks, 'balance').delta, 0);
ok('new coins equation uses earned as closing', check(vNew.checks, 'coins').status === 'pass');

section('verifyStatement — failure injection');
var bad = Object.assign({}, nw, { total: 9999 });
var vb = Calc.verifyStatement(bad, { prevRecord: null, cardNo: '' });
ok('mad fails on mismatch', check(vb.checks, 'mad').status === 'fail');
ok('balance fails on mismatch', check(vb.checks, 'balance').status === 'fail');
ok('hasBlocking true', Calc.hasBlocking(vb.checks, {}) === true);
var ex = Calc.applyExceptions(vb.checks, { mad: 'bank rounds differently', balance: 'manual check' });
ok('exceptions accept', ex.checks.filter(function (c) { return c.status === 'accepted'; }).length === 2);
ok('hasBlocking false after exceptions', Calc.hasBlocking(ex.checks, { mad: 1, balance: 1 }) === false);

/* ------------------------------------------------------------------ */
section('ledger coin prediction');
eq('UPI 1000 → 15', Calc.predictedCoins({ category: 'upi', amount: 1000 }).coins, 15);
eq('Grocery 2000 → 30', Calc.predictedCoins({ category: 'grocery', amount: 2000 }).coins, 30);
eq('Base 1000 → 15', Calc.predictedCoins({ category: 'base', amount: 1000 }).coins, 15);
eq('Tata 2000 → 70', Calc.predictedCoins({ category: 'tata', amount: 2000 }).coins, 70);
eq('Tata program name', Calc.predictedCoins({ category: 'tata', amount: 2000 }).program, 'Add_TataPayment');
eq('NoCoins → 0', Calc.predictedCoins({ category: 'nocoins', amount: 1000 }).coins, 0);
eq('Payment → 0', Calc.predictedCoins({ category: 'payment', amount: 5000 }).coins, 0);
eq('round up 66.66 → 67', Calc.predictedCoins({ category: 'tata', amount: 1900 }).coins, 67);
eq('classify upi', Calc.classifyMerchant('UPI-MyGate-123', false), 'upi');
eq('classify tata merchant', Calc.classifyMerchant('TATAPAYMENTSLIMITEGURGOAN', false), 'tata');
eq('classify grocery', Calc.classifyMerchant('BIGBASKET', false), 'grocery');
eq('classify payment', Calc.classifyMerchant('BPPY CC PAYMENT', true), 'payment');
eq('classify default base', Calc.classifyMerchant('SRI KRISHNA SWEETS', false), 'base');

/* ------------------------------------------------------------------ */
section('reconcile engine');
var stT = {
  periodTo: '18/11/2025', periodFrom: '19/10/2025', statementDate: '18/11/2025',
  txns: [
    { date: '20/10/2025', desc: 'DMART', amount: 200, credit: false },
    { date: '25/10/2025', desc: 'PIZZA', amount: 150, credit: false },
    { date: '30/10/2025', desc: 'BPPY CC PAYMENT', amount: 5000, credit: true }
  ],
  bonusPrograms: [{ program: 'Base_Grocery', coins: 3 }]
};
var ledgerT = [
  { id: 'a', date: '20/10/2025', desc: 'DMART buy', amount: 200, category: 'grocery', reconciled: '' },
  { id: 'b', date: '25/10/2025', desc: 'Pizza nite', amount: 150, category: 'base', reconciled: '' },
  { id: 'c', date: '31/10/2025', desc: 'missed row', amount: 99, category: 'base', reconciled: '' },
  { id: 'd', date: '30/10/2025', desc: 'card payment', amount: 5000, category: 'payment', reconciled: '' },
  { id: 'e', date: '02/09/2025', desc: 'outside window', amount: 500, category: 'base', reconciled: '' }
];
var rc = Calc.reconcile(stT, ledgerT, { periodTo: '18/10/2025' });
eq('matched count', rc.matchedCount, 3);
ok('outside window excluded', rc.bookOnly.filter(function (e) { return e.date === '02/09/2025'; }).length === 0);
eq('book only count', rc.bookOnlyCount, 1);
eq('book only entry', rc.bookOnly[0].desc, 'missed row');
eq('stmt only count', rc.stmtOnlyCount, 0);
eq('payments compare', rc.payInBook, 0);
eq('payments statement', rc.payInStmt, 0);
eq('expected Base_Grocery', rc.expected['Base_Grocery'], 3);
eq('actual Base_Grocery', rc.actual['Base_Grocery'], 3);
ok('matches pencil to exact same-day amount', rc.matched[0].entry.desc === 'DMART buy' && rc.matched[0].txn.desc === 'DMART');

var rc2 = Calc.reconcile({ periodTo: '18/11/2025', periodFrom: '19/10/2025', txns: [{ date: '21/10/2025', desc: 'X', amount: 100, credit: false }], bonusPrograms: [] }, [{ id: 'x', date: '20/10/2025', desc: 'X', amount: 100, category: 'base', reconciled: '' }], null);
eq('different day not matched', rc2.stmtOnlyCount, 1);
eq('amount-differs day list empty', rc2.bookOnlyCount, 1);

/* ------------------------------------------------------------------ */
section('migrateBundle / schema');
var m0 = Calc.migrateBundle({ version: 0, records: [{ periodTo: '18/03/2025', total: '9012.15' }], ledger: [{ desc: 'x', amount: '100', category: 'upi' }] });
eq('upgraded version', m0.version, 4);
eq('record total coerced', m0.records[0].total, 9012.15);
eq('ledger amount coerced', m0.ledger[0].amount, 100);
eq('card defaulted', m0.card.no, '');
ok('future schema rejected', Calc.migrateBundle({ version: 99 }).incompatible);
ok('garbage rejected', Calc.migrateBundle(null).incompatible);
eq('SCHEMA_VERSION', Calc.SCHEMA_VERSION, 4);

section('schema v1 → v4 (rewards & payments fields carried through)');
var m1 = Calc.migrateBundle({ version: 1, card: { no: 'x' }, records: [], ledger: [], redemptions: [{ coins: '100', value: '25' }], payments: [{ amount: '500', forPeriod: '18/11/2025' }] });
eq('migrated to v4', m1.version, 4);
ok('redemptions array present', Array.isArray(m1.redemptions));
ok('payments array present', Array.isArray(m1.payments));
eq('redemption coins coerced', m1.redemptions[0].coins, 100);
eq('redemption value coerced', m1.redemptions[0].value, 25);
eq('payment amount coerced', m1.payments[0].amount, 500);
eq('coin value defaults to 0.25', m1.rewardsConfig.valuePerCoin, 0.25);
var m2 = Calc.migrateBundle({ version: 0, records: [], ledger: [], rewardsConfig: { valuePerCoin: 1 } });
eq('coin value preserved when set', m2.rewardsConfig.valuePerCoin, 1);

section('rewards');
eq('rewardsValue default (500 coins @ 0.25)', Calc.rewardsValue(500, undefined), 125);
eq('rewardsValue custom rate', Calc.rewardsValue(400, 1), 400);
eq('DEFAULT_COIN_VALUE', Calc.DEFAULT_COIN_VALUE, 0.25);
var tl = Calc.rewardsTimeline([{ periodTo: '18/04/2025', earnedNeuCoins: 100, closingNeuCoins: 150 }, { periodTo: '18/05/2025', earnedNeuCoins: 50, closingNeuCoins: 200 }]);
eq('timeline earned', tl.earned.map(function (p) { return p.coins; }).join(','), '100,50');
eq('timeline balance', tl.balance.map(function (p) { return p.coins; }).join(','), '150,200');
var rr = Calc.redemptionReconcile(
  [{ earnedNeuCoins: 1659, transferredNeuCoins: 321 }, { earnedNeuCoins: 475, transferredNeuCoins: 167 }],
  [{ coins: 200 }, { coins: 100 }]);
eq('redemption total earned', rr.totalEarned, 2134);
eq('redemption total transferred', rr.totalTransferred, 488);
eq('redemption total redeemed', rr.totalRedeemed, 300);
eq('redemption net', rr.netUnspent, 1346);
var rc = Calc.rewardsByCategory(stT, ledgerT, { periodTo: '18/10/2025' });
eq('rewards expected grocery', rc.expected['grocery'], 3);
eq('rewards expected base', rc.expected['base'], 3);
eq('rewards actual grocery', rc.actual['grocery'], 3);

section('dues & payments');
var recP = { periodTo: '18/11/2025', statementDate: '18/11/2025', total: 10000, minimumDue: 500 };
eq('no payment → none', Calc.paymentForRecord(recP, []).kind, 'none');
eq('no payment outstanding', Calc.paymentForRecord(recP, []).outstanding, 10000);
eq('full', Calc.paymentForRecord(recP, [{ amount: 10000, forPeriod: '18/11/2025' }]).kind, 'full');
eq('full outstanding 0', Calc.paymentForRecord(recP, [{ amount: 10000, forPeriod: '18/11/2025' }]).outstanding, 0);
eq('minimum', Calc.paymentForRecord(recP, [{ amount: 500, forPeriod: '18/11/2025' }]).kind, 'minimum');
eq('partial', Calc.paymentForRecord(recP, [{ amount: 200, forPeriod: '18/11/2025' }]).kind, 'partial');
eq('sum of two payments', Calc.paymentForRecord(recP, [{ amount: 6000, forPeriod: '18/11/2025' }, { amount: 4000, forPeriod: '18/11/2025' }]).totalPaid, 10000);
var dsPast = Calc.dueStatus({ dueDate: '08/12/2025', total: 10000, minimumDue: 500 }, [], new Date(2025, 11, 10));
ok('past due overdue', dsPast.overdue === true);
eq('past due days left', dsPast.daysLeft, -2);
var dsFut = Calc.dueStatus({ dueDate: '08/12/2025', total: 10000, minimumDue: 500 }, [{ amount: 500, forPeriod: '' }], new Date(2025, 11, 1));
eq('future due days left', dsFut.daysLeft, 7);
ok('not overdue when due ahead', dsFut.overdue === false);
ok('settled after payment', Calc.dueStatus({ dueDate: '08/12/2025', total: 10000, minimumDue: 500, periodTo: '18/11/2025' }, [{ amount: 10000, forPeriod: '18/11/2025' }], new Date(2025, 11, 1)).settled === true);
eq('utilization 25%', Calc.utilizationOf({ total: 25000, creditLimit: 100000 }), 25);
eq('utilization null when no limit', Calc.utilizationOf({ total: 25000 }), null);
var isum = Calc.interestSummary([{ periodTo: '18/04/2025', finance: 0 }, { periodTo: '18/05/2025', finance: 12.5 }]);
eq('interest total', isum.total, 12.5);
eq('interest records', isum.perRecord.length, 2);

section('PRIVACY GUARD — no personal data anywhere in neu-tracker/');
var ROOT = path.join(__dirname, '..', 'neu-tracker');
var FORBIDDEN = ['TESTACCT0201', 'TEST', 'TESTSURNAME', '5432', '0000000000000000000', '1 TEST LANE', 'TEST RESIDENCE', 'TESTHOLDER@EXAMPLE.COM'];
var walk = [];
(function collect(dir) {
  fs.readdirSync(dir).forEach(function (f) {
    var full = path.join(dir, f);
    if (f === 'lib') return; /* vendored third-party libs (pdf.js, chart.js) are out of scope */
    if (fs.statSync(full).isDirectory()) collect(full);
    else if (/\.(js|html|css|json)$/.test(f)) walk.push(full);
  });
})(ROOT);
var leaked = [];
var bundleData = null;
walk.forEach(function (f) {
  var content = fs.readFileSync(f, 'utf8');
  FORBIDDEN.forEach(function (tok) {
    if (content.indexOf(tok) !== -1) leaked.push(f + ' contains ' + tok);
  });
  if (f.indexOf('bundle.js') !== -1) {
    bundleData = {};
    new Function('window', content)(bundleData);
    ok('bundle card number empty', wVerify(bundleData, 'DATA.card.no') === '');
  }
});
function wVerify(d, path) {
  try { return path.split('.').reduce(function (o, k) { return (o == null ? o : o[k]); }, d); } catch (e) { return undefined; }
}
eq('no forbidden personal tokens in app files', leaked.length, 0);
ok('bundle has no password key', !bundleData || !('password' in bundleData.DATA));

/* ------------------------------------------------------------------ */
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);