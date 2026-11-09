'use strict';
/* Unit tests for the mutual-fund CAS parser (mf.js) and MF math (calc.js).
 * Run: node test/invest-mf.test.js
 */
var path = require('path');
var Calc = require(path.join(__dirname, '..', 'investments', 'calc.js'));
var Mf = require(path.join(__dirname, '..', 'investments', 'mf.js'));

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

function txn(date, description, amount, units, balance, type) {
  return { date: date, description: description, amount: amount, units: units, nav: null, balance: balance, type: type, dividend_rate: null };
}

console.log('mf.js — numeric/date helpers');
eq('parseDMonY', Mf.parseDMonY('09-Nov-2026'), '2026-11-09');
eq('parseDMonY with spaces', Mf.parseDMonY('9 Nov 2026'), '2026-11-09');
eq('parseDMonY invalid', Mf.parseDMonY('nope'), null);
eq('decimal groups', Mf.decimal('1,23,456.78'), 123456.78);
eq('decimal parens are negative', Mf.decimal('(1,000.50)'), -1000.5);
eq('money strips currency', Mf.money('INR 12,345.67'), 12345.67);

console.log('mf.js — transaction classifier');
eq('purchase', Mf.classify('Purchase', 10).type, 'PURCHASE');
eq('SIP purchase', Mf.classify('Purchase - SIP', 10).type, 'PURCHASE_SIP');
eq('redemption', Mf.classify('Redemption', -5).type, 'REDEMPTION');
eq('switch in', Mf.classify('Switch In - from other scheme', 2).type, 'SWITCH_IN');
eq('switch out', Mf.classify('Switch Out - to other scheme', -2).type, 'SWITCH_OUT');
eq('dividend reinvest', Mf.classify('IDCW Reinvestment', 3).type, 'DIVIDEND_REINVEST');
eq('dividend payout', Mf.classify('Dividend Payout', 3).type, 'DIVIDEND_PAYOUT');
eq('stamp duty', Mf.classify('Stamp Duty', 0.5).type, 'STAMP_DUTY_TAX');
eq('STT', Mf.classify('STT', 0.5).type, 'STT_TAX');
eq('reversal', Mf.classify('Purchase Reversal', -10).type, 'REVERSAL');

console.log('mf.js — type / subtype classification');
eq('midcap', Mf.typeFromName('Axis Midcap Fund - Growth'), 'EQUITY');
eq('large & mid cap subtype', Mf.subTypeFromName('HDFC Large & Mid Cap Fund - Growth', 'EQUITY'), 'Large & Mid Cap');
eq('sectoral housing', Mf.subTypeFromName('SBI Housing Opportunity Fund - Growth', 'EQUITY'), 'Sectoral/Thematic');
eq('life cycle is hybrid', Mf.typeFromName('ICICI Prudential Life Cycle Fund - Growth'), 'HYBRID');
eq('multi cap not bank', Mf.subTypeFromName('Bank of India Multi Cap Fund - Growth', 'EQUITY'), 'Multi Cap');
eq('dividend yield', Mf.subTypeFromName('SBI Dividend Yield Fund - Growth', 'EQUITY'), 'Dividend Yield');
eq('arbitrage is hybrid', Mf.typeFromName('Kotak Arbitrage Fund - Growth'), 'HYBRID');
eq('liquid is debt', Mf.typeFromName('HDFC Liquid Fund - Growth'), 'DEBT');
eq('unknown', Mf.typeFromName('Some Other Product'), 'OTHER');

console.log('mf.js — scheme name cleanup');
eq('strips formerly clause',
  Mf.parsedSchemeName('Altiva Hybrid Long-Short Fund - Regular Plan - Growth (formerly Altiva Equity Long-Short Fund)'),
  'Altiva Hybrid Long-Short Fund - Regular Plan - Growth');
eq('strips demat suffix',
  Mf.parsedSchemeName('HDFC Flexi Cap Fund - Growth (Non-Demat)'),
  'HDFC Flexi Cap Fund - Growth');
eq('drops trailing open paren',
  Mf.parsedSchemeName('Axis Small Cap Fund - Growth ('),
  'Axis Small Cap Fund - Growth');

console.log('mf.js — toRecords maps folio/scheme/transactions');
(function () {
  var cas = {
    folios: [{
      folio: '12345678 / 90', amc: 'Axis Mutual Fund', PAN: 'ABCDE1234F', KYC: 'OK', name: 'A Holder',
      schemes: [{
        scheme: 'Axis Midcap Fund - Growth', isin: 'INF846K01ABC1', rta_code: '128TSDGG', rta: 'CAMS',
        advisor: 'ARN-123', open: 10, close: 12.5, close_calculated: 12.5, nominees: ['N One'],
        valuation: { nav: 55.5, date: '2026-11-09', value: 693.75, cost: 500 },
        transactions: [
          txn('2020-01-01', 'Purchase', 500, 10, 10, 'PURCHASE'),
          txn('2021-01-01', 'Purchase - SIP', 100, 2.5, 12.5, 'PURCHASE_SIP')
        ]
      }, {
        scheme: 'Axis Gilt Fund - IDCW Payout', isin: 'INF846K01XYZ9', rta_code: '128TGDIV', rta: 'CAMS',
        advisor: '', open: 0, close: 0, close_calculated: 0, nominees: [],
        valuation: { nav: 10, date: '2026-11-09', value: 0, cost: 0 },
        transactions: [txn('2019-01-01', 'Purchase', 1000, 100, 100, 'PURCHASE')]
      }]
    }]
  };
  var recs = Mf.toRecords(cas);
  eq('two scheme records', recs.length, 2);
  var a = recs[0], b = recs[1];
  eq('record amc', a.amc, 'Axis Mutual Fund');
  eq('record folio', a.folio, '12345678 / 90');
  eq('record pan', a.pan, 'ABCDE1234F');
  eq('record holder', a.holder, 'A Holder');
  eq('record isin', a.isin, 'INF846K01ABC1');
  eq('record rta code', a.rtaCode, '128TSDGG');
  eq('record nav date', a.navDate, '2026-11-09');
  eq('record market value', a.marketValue, 693.75);
  eq('record cost', a.cost, 500);
  eq('record distribution growth', a.distribution, 'Growth');
  eq('record type equity', a.invType, 'EQUITY');
  eq('record subtype mid cap', a.invSubType, 'Mid Cap');
  eq('record transactions', a.transactions.length, 2);
  eq('transaction type kept', a.transactions[1].type, 'PURCHASE_SIP');
  eq('record open units', a.open, 10);
  eq('record close units', a.close, 12.5);
  eq('closed record distribution', b.distribution, 'IDCW');
  eq('closed record defaults', b.open + '|' + b.close, '0|0');
  eq('record id includes folio+scheme', a.id.indexOf('|12345678 / 90|') > 0, true);
})();

console.log('calc.js — MF status/flows/XIRR');
(function () {
  var open = {
    folio: 'F1', scheme: 'Fund A', marketValue: 121000, navDate: '2022-01-01', cost: 100000, close: 100,
    invType: 'EQUITY',
    transactions: [
      { date: '2020-01-01', type: 'PURCHASE', amount: 100000 },
      { date: '2021-01-01', type: 'DIVIDEND_PAYOUT', amount: 1000 },
      { date: '2021-06-01', type: 'DIVIDEND_REINVEST', amount: 500 },
      { date: '2021-07-01', type: 'MISC', amount: 0 }
    ]
  };
  var closed = {
    folio: 'F2', scheme: 'Fund B', marketValue: 0, navDate: '2026-11-09', cost: 0, close: 0,
    invType: 'DEBT',
    transactions: [
      { date: '2018-01-01', type: 'PURCHASE', amount: 5000 },
      { date: '2019-01-01', type: 'REDEMPTION', amount: -6000 }
    ]
  };
  eq('open when close units > 0', Calc.mfStatus(open), 'Open');
  eq('closed when zero balance', Calc.mfStatus(closed), 'Closed');
  eq('first date', Calc.mfFirstDate(open), '2020-01-01');
  eq('end date of open uses nav date', Calc.mfEndDate(open), '2022-01-01');
  eq('end date of closed uses last txn', Calc.mfEndDate(closed), '2019-01-01');
  close('period years', Calc.mfPeriod(open).years, 2, 0.01);
  var flows = Calc.mfFlows(open);
  eq('flows skip reinvest/misc and add terminal value', flows.length, 3);
  eq('purchase flow negated', flows[0].amt, -100000);
  eq('dividend payout is positive', flows[1].amt, 1000);
  eq('terminal flow is market value', flows[2].amt, 121000);
  var closedFlows = Calc.mfFlows(closed);
  eq('closed redemption is positive', closedFlows[1].amt, 6000);
  eq('closed has no terminal flow', closedFlows.length, 2);
  var simple = { folio: 'F0', scheme: 'Fund S', marketValue: 121000, navDate: '2022-01-01', cost: 100000, close: 1, transactions: [{ date: '2020-01-01', type: 'PURCHASE', amount: 100000 }] };
  close('single-purchase XIRR ~10%', Calc.mfXirr(simple), 0.1, 0.002);
  eq('portfolio XIRR combines both', Calc.mfPortfolioXirr([open, closed]) != null, true);
})();

console.log('calc.js — MF enrich + summary + sort');
(function () {
  var a = {
    folio: 'F1', scheme: 'Fund A', marketValue: 1200, navDate: '2026-01-01', cost: 1000, close: 10,
    invType: 'EQUITY', transactions: [
      { date: '2024-01-01', type: 'PURCHASE', amount: 500 },
      { date: '2024-06-01', type: 'PURCHASE_SIP', amount: 300 },
      { date: '2024-07-01', type: 'SWITCH_IN', amount: 200 },
      { date: '2024-08-01', type: 'REDEMPTION', amount: -100 }
    ]
  };
  var b = {
    folio: 'F2', scheme: 'Fund B', marketValue: 0, navDate: '2026-01-01', cost: 0, close: 0,
    invType: 'DEBT', transactions: [{ date: '2020-01-01', type: 'PURCHASE', amount: 100 }]
  };
  var e = Calc.mfEnrich(a);
  eq('enriched status', e.status, 'Open');
  eq('invested sums purchase/sip/switch-in only', e.invested, 1000);
  eq('gain', e.gain, 200);
  eq('return pct', e.returnPct, 20);
  eq('sip flag', e.sip, true);

  var s = Calc.mfSummary([a, b]);
  eq('summary count', s.count, 2);
  eq('summary open count', s.openCount, 1);
  eq('summary closed count', s.closedCount, 1);
  eq('summary cost', s.cost, 1000);
  eq('summary value', s.value, 1200);
  eq('summary gain', s.gain, 200);
  eq('summary byType equity', s.byType.EQUITY.count, 1);
  close('summary return pct', s.returnPct, 20, 0.001);

  var sorted = Calc.mfSort([b, a]);
  eq('sort open first', sorted[0].scheme, 'Fund A');
  eq('sort closed last', sorted[1].scheme, 'Fund B');

  var f1 = { scheme: 'Axis Value Fund - Direct Growth', folio: '12345678 / 2', marketValue: 500, close: 1 };
  var f2 = { scheme: 'Axis Value Fund - Direct Growth', folio: '12345678 / 1', marketValue: 500, close: 1 };
  var f3 = { scheme: 'Axis Value Fund - Direct Growth', folio: '99999999 / 1', marketValue: 600, close: 1 };
  var fs = Calc.mfSort([f1, f3, f2]);
  eq('higher value first, then equal value + name sorts by folio number', fs.map(function (r) { return r.folio; }).join(','), '99999999 / 1,12345678 / 1,12345678 / 2');
  eq('folio compare is numeric not lexicographic', Calc.mfFolioCmp('9 / 1', '10 / 1') < 0, true);
})();

console.log('calc.js — MF equity subtype split');
(function () {
  function mk(name, sub, cost, val) {
    return { folio: 'F', scheme: name, invType: 'EQUITY', invSubType: sub, amc: 'Axis', cost: cost, marketValue: val, close: 1, navDate: '2026-01-01', transactions: [{ date: '2024-01-01', type: 'PURCHASE', amount: cost }] };
  }
  var s2 = Calc.mfSummary([mk('A', 'Large Cap', 100, 120), mk('B', 'Mid Cap', 200, 180), mk('C', 'Large Cap', 50, 60)]);
  eq('subtype large cap count', s2.bySubType['Large Cap'].count, 2);
  eq('subtype large cap value', s2.bySubType['Large Cap'].value, 180);
  eq('subtype large cap return pct', s2.bySubType['Large Cap'].returnPct, 20);
  eq('subtype mid cap count', s2.bySubType['Mid Cap'].count, 1);
  eq('subtype type tagged EQUITY', s2.bySubType['Mid Cap'].type, 'EQUITY');
  eq('byAmc gain finalized', s2.byAmc.Axis.gain, 10);
  close('byType xirr present for group', s2.byType.EQUITY.xirr, Calc.mfPortfolioXirr([mk('A', 'Large Cap', 100, 120), mk('B', 'Mid Cap', 200, 180), mk('C', 'Large Cap', 50, 60)]), 0.0000001);
})();

console.log('mf.js — parsePdf keeps caller data reusable');
(function () {
  var src = new Uint8Array([1, 2, 3, 4]);
  var fake = {
    GlobalWorkerOptions: {},
    getDocument: function (opts) {
      var buf = opts.data.buffer;
      if (typeof buf.transfer === 'function') buf.transfer();
      else if (typeof structuredClone === 'function') structuredClone(buf, { transfer: [buf] });
      var e = new Error('Incorrect Password');
      e.name = 'PasswordException';
      return { promise: Promise.reject(e) };
    }
  };
  Mf.parsePdf(src, fake, 'bad').then(function () {
    eq('parsePdf rejects on bad password', 'resolved', 'rejected');
    finish();
  }, function (e) {
    eq('parsePdf rejects on bad password', e.name, 'PasswordException');
    eq('input stays usable for a password retry', src.byteLength, 4);
    finish();
  });
})();

function finish() {
  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
