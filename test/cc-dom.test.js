'use strict';
/* DOM integration test: boots the real neu-tracker/ app in jsdom and verifies
 * the Rewards and Bills views, ledger/redemption/payment data flows, and the
 * schema-v5 bundle. Scripts are injected manually since jsdom cannot fetch
 * file:// siblings. Run: node test/cc-dom.test.js  (needs jsdom)
 */
var path = require('path');
var fs = require('fs');
var { JSDOM } = require('jsdom');

var ROOT = path.join(__dirname, '..');
var passed = 0, failed = 0;
function eq(name, actual, expected) {
  if (String(actual) === String(expected)) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('FAIL  ' + name + ' — got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)); }
}
function ok(name, cond) { eq(name, !!cond, true); }
function $(sel, doc) { return (doc || document).querySelector(sel); }
function $$(sel, doc) { return Array.from((doc || document).querySelectorAll(sel)); }
function setValue(sel, v, doc) {
  var e = $(sel, doc);
  e.value = v;
  e.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

var html = fs.readFileSync(path.join(ROOT, 'neu-tracker', 'index.html'), 'utf8')
  .replace(/<script src="lib\/pdf\.min\.js"><\/script>/, '')
  .replace(/<script src="parser\.js"><\/script>/, '')
  .replace(/<script src="calc\.js"><\/script>/, '')
  .replace(/<script src="lib\/chart\.umd\.js"><\/script>/, '')
  .replace(/<script src="data\/bundle\.js"><\/script>/, '')
  .replace(/<script src="app\.js"><\/script>/, '')
  .replace(/navigator\.serviceWorker\.register\('sw\.js'\)\.catch\(function \(\) \{\}\);/, '');

var dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/neu-tracker/', pretendToBeVisual: true });
var document = dom.window.document;
dom.window.eval('window.pdfjsLib = { GlobalWorkerOptions: {} };');
/* Chart stub: records constructions so we can assert drawCharts runs without
 * throwing (it used to crash on canvas.parentNode.querySelector('h4') = null). */
dom.window.eval('window.__chartCalls = []; window.Chart = function (el, cfg) { window.__chartCalls.push({ el: el.id || String(el), data: cfg && cfg.data }); return { destroy: function () {} }; };');
dom.window.eval(fs.readFileSync(path.join(ROOT, 'neu-tracker', 'parser.js'), 'utf8'));
dom.window.eval(fs.readFileSync(path.join(ROOT, 'neu-tracker', 'calc.js'), 'utf8'));
dom.window.eval(fs.readFileSync(path.join(ROOT, 'neu-tracker', 'data', 'bundle.js'), 'utf8'));
dom.window.eval(fs.readFileSync(path.join(ROOT, 'neu-tracker', 'app.js'), 'utf8'));

function whenReady(fn) {
  var t = setInterval(function () {
    if (dom.window.App && dom.window.Calc) { clearInterval(t); fn(); }
  }, 10);
  setTimeout(function () { clearInterval(t); console.log('FAIL timed out waiting for app boot'); process.exit(1); }, 5000);
}

whenReady(function run() {
  var App = dom.window.App;
  var Calc = dom.window.Calc;
  var DATA = dom.window.DATA;

  console.log('1) boot — bundle migrated to schema v5 on load');
  eq('data version 5', DATA.version, 5);
  ok('redemptions array', Array.isArray(DATA.redemptions));
  ok('payments array (drained into ledger at v5)', Array.isArray(DATA.payments));
  eq('payments drained', DATA.payments.length, 0);
  ok('feeConfig present', !!DATA.feeConfig);
  eq('coin value default', DATA.rewardsConfig.valuePerCoin, 0.25);
  ok('landing section present', !!$('#landing'));

  console.log('1b) file inputs use sr-only (Android picker regression)');
  /* The Android/Chrome picker never opens for a programmatic .click() on an
   * input with display:none (the hidden attribute). ipo/investments/tn-utilities
   * all use .sr-only; neu-tracker regressed to hidden. */
  ['#importFile', '#openBundleInput'].forEach(function (sel) {
    var inp = $(sel, document);
    ok(sel + ' has sr-only class', inp && inp.classList.contains('sr-only'), true);
    ok(sel + ' is not hidden-attr', !(inp && inp.hasAttribute('hidden')), true);
  });

  console.log('2) ledger — add an entry');
  setValue('#leDate', '10/11/2025');
  setValue('#leDesc', 'DMART buy');
  setValue('#leCat', 'grocery');
  setValue('#leAmt', '200');
  $('#addBtn').click();
  eq('ledger entry added', DATA.ledger.length, 1);
  eq('ledger row rendered', $('#ledgerList').textContent.indexOf('DMART buy') >= 0, true);
  eq('predicted coins shown', $('#ledgerList').textContent.indexOf('+3') >= 0, true);

  console.log('3) rewards view');
  $('#rewardsGo').click();
  eq('rewards visible', $('#rewards').style.display, 'block');
  eq('rewards summary shows coin value', $('#rwSummary').textContent.indexOf('Worth of earned') >= 0, true);

  console.log('4) redemptions — add one');
  setValue('#rwDate', '12/11/2025');
  setValue('#rwCoins', '100');
  setValue('#rwValue', '25');
  $('#rwAddBtn').click();
  eq('redemption added', DATA.redemptions.length, 1);
  eq('redemption coins stored', DATA.redemptions[0].coins, 100);
  eq('redemption listed', $('#rwList').textContent.indexOf('100 coins') >= 0, true);

  console.log('5) home — due board + interest (merged in from Bills)');
  $('#homeGo').click();
  eq('landing visible', $('#landing').style.display, 'block');
  eq('due board on home', $('#blDue').textContent.indexOf('No statements yet') >= 0, true);
  eq('interest on home', $('#blInterest').textContent.indexOf('No statements yet') >= 0, true);
  eq('payment log on ledger', $('#ledger').style.display !== 'block', true);
  $('#ledgerGo').click();
  eq('ledger form has a For-period selector (for Payment entries)', !!$('#lePeriod'), true);
  eq('period selector hidden for the default (upi) category', $('#lePeriodWrap').style.display, 'none');
  setValue('#leCat', 'payment');
  eq('period selector shown for Payment category', $('#lePeriodWrap').style.display !== 'none', true);
  setValue('#leCat', 'upi');

  console.log('6) reconcile engine against the in-app ledger');
  DATA.records.push({ id: 's-1', periodTo: '18/11/2025', periodFrom: '19/10/2025', total: 200, minimumDue: 10, prevDues: 0, payments: 0, purchases: 200, finance: 0, creditLimit: 100000, availLimit: 99800, dueDate: '08/12/2025', earnedNeuCoins: 3, transferredNeuCoins: 0, openingNeuCoins: 0, adjustedNeuCoins: 0, closingNeuCoins: 3, bonusPrograms: [{ program: 'Base_Grocery', coins: 3 }], txns: [{ date: '10/11/2025', desc: 'DMART', amount: 200, credit: false, base: 0 }] });
  $('#rewardsGo').click();
  eq('cycle breakdown expected grocery', $('#rwCycle').textContent.indexOf('expected +3') >= 0, true);
  eq('redeem reconcile shows net −97 (3 earned − 0 transferred − 100 redeemed)', $('#rwReconcile').textContent.indexOf('more redeemed than earned') >= 0 && $('#rwReconcile').textContent.indexOf('-97') >= 0, true);
  $('#homeGo').click();
  eq('due board row rendered (home)', $('#blDue').textContent.indexOf('due 08/12/2025') >= 0, true);
  /* log the repayment as a ledger Payment entry (replaces the old Payments panel) */
  $('#ledgerGo').click();
  eq('period selector now offers the new bill', Array.from($('#lePeriod').options).some(function (o) { return o.value === '18/11/2025'; }), true);
  setValue('#leDate', '12/11/2025');
  setValue('#leDesc', 'paid off 18/11 bill');
  setValue('#leCat', 'payment');
  setValue('#lePeriod', '18/11/2025');
  setValue('#leAmt', '200');
  $('#addBtn').click();
  eq('payment logged as a ledger entry', DATA.ledger.length, 2);
  eq('payment entry is category payment', DATA.ledger[1].category, 'payment');
  eq('payment entry carries forPeriod', DATA.ledger[1].forPeriod, '18/11/2025');
  $('#homeGo').click();
  eq('due board shows payment', $('#blDue').textContent.indexOf('paid') >= 0, true);
  $('#ledgerGo').click();
  eq('payment listed on ledger', $('#ledgerList').textContent.indexOf('for 18/11/2025') >= 0, true);

  console.log('6c) home — bulk-book statement rows into the ledger (no Reconcile needed)');
  /* isolated record: one statement row not yet in the ledger, and (because
   * it is the oldest record) no statement row falls inside its window — so
   * stmtOnly is exactly that one row and the Home booking button is shown. */
  DATA.records.push({ id: 's-9', periodTo: '18/09/2025', periodFrom: '19/08/2025', total: 150, minimumDue: 10, prevDues: 0, payments: 0, purchases: 150, finance: 0, creditLimit: 100000, availLimit: 99850, dueDate: '08/10/2025', earnedNeuCoins: 1, transferredNeuCoins: 0, openingNeuCoins: 0, adjustedNeuCoins: 0, closingNeuCoins: 1, bonusPrograms: [{ program: 'Base_Grocery', coins: 1 }], txns: [{ date: '05/09/2025', desc: 'BIGBAZZAR', amount: 150, credit: false, base: 0 }] });
  $('#homeGo').click();
  var addBtns = $$('#landingStats button', document).filter(function (b) { return b.textContent.trim() === 'Add 1 to ledger'; });
  ok('home shows an "Add N to ledger" button for an un-reconciled statement', addBtns.length >= 1, true);
  if (addBtns.length) {
    var beforeLedger = DATA.ledger.length;
    addBtns[0].click();
    eq('clicking it books the statement-only row into the ledger', DATA.ledger.length, beforeLedger + 1);
    /* after booking, that row is matched (no longer statement-only), so the button vanishes */
    eq('button is gone once the row is booked', $$('#landingStats button', document).filter(function (b) { return b.textContent.trim() === 'Add 1 to ledger'; }).length, 0);
  }

  console.log('6d) home history — last 3 entries + show-more (3 at a time)');
  [6, 5, 4, 3, 2, 1, 12].forEach(function (mm) { // 7 more records → 9 total (Dec is 2024)
    var y = mm === 12 ? 2024 : 2025;
    var mm2 = (mm === 12 ? 11 : mm - 1);
    var p2 = function (n) { return String(n).length < 2 ? '0' + n : String(n); };
    DATA.records.push({ id: 's-h' + y + mm, periodTo: '18/' + p2(mm) + '/' + y, periodFrom: '19/' + p2(mm2) + '/' + y, total: 10 * mm, minimumDue: 5, prevDues: 0, payments: 0, purchases: 10 * mm, finance: 0, creditLimit: 100000, availLimit: 99900, dueDate: '08/' + p2(mm) + '/' + y, closingNeuCoins: 0, bonusPrograms: [], txns: [] });
  });
  $('#homeGo').click();
  function histRows() { return $$('#landingStats .table .lrow', document).length; }
  function moreBtn() { return $$('#landingStats button', document).filter(function (b) { return /^Show \d+ more$/.test(b.textContent.trim()); })[0]; }
  eq('history shows only the last 3 entries', histRows(), 3);
  ok('show-more button appears when there are more than 3', !!moreBtn(), true);
  moreBtn().click();
  eq('clicking show-more adds 3 more', histRows(), 6);
  moreBtn().click();
  eq('second click shows the remaining 3', histRows(), 9);
  eq('show-more button gone once all shown', !!moreBtn(), false);

  console.log('6e) home due board — last 3 bills + show-more (3 at a time)');
  function dueRows() { return $$('#blDue .table .lrow', document).length; }
  function dueMore() { return $$('#blDue button', document).filter(function (b) { return /^Show \d+ more$/.test(b.textContent.trim()); })[0]; }
  eq('due board shows only the last 3 bills', dueRows(), 3);
  ok('due board show-more button appears', !!dueMore(), true);
  dueMore().click();
  eq('due board shows 6 after click', dueRows(), 6);
  dueMore().click();
  eq('due board shows all 9 after second click', dueRows(), 9);
  eq('due board show-more gone once all shown', !!dueMore(), false);
  /* latest statement s-1: creditLimit 100000 − availLimit 99800 − total 200 = 0 */
  eq('unbilled (approx) shown on home', $('#blDue').textContent.indexOf('Unbilled (approx)') >= 0, true);
  DATA.records.forEach(function (r) { if (r.id === 's-1') r.availLimit = 99700; });
  $('#homeGo').click();
  eq('unbilled = limit − avail − total (100)', $('#blDue').textContent.indexOf('₹100') >= 0, true);

  console.log('6b) home charts draw without crashing (regression: h4 lookup)');
  $('#homeGo').click();
  /* drawCharts runs on requestAnimationFrame — wait a frame */
  setTimeout(function () {
    var calls = (dom.window.__chartCalls || []).map(function (c) { return c.el; });
    ok('monthly purchases chart drawn (records present)', calls.indexOf('chartMonthly') >= 0, true);
    ok('spend-by-category chart drawn (ledger present)', calls.indexOf('chartCats') >= 0, true);

      console.log('7) persistence round-trip');
      var saved = JSON.parse(dom.window.localStorage.getItem('ne.tracker.data'));
      eq('persisted version', saved.version, 5);
      eq('persisted ledger entries', saved.ledger.length, 3); // 1 grocery (2) + 1 payment (6) + 1 bulk-booked statement row (6c)
      eq('persisted payments drained', saved.payments.length, 0);
      eq('persisted redemptions', saved.redemptions.length, 1);
      ok('no password persisted', !('password' in saved));

      console.log('8) bundle import — bare JSON backup (no window.DATA wrapper)');
      /* run last: loadBundleFile replaces the app's DATA object, so the
       * captured `DATA` reference above goes stale afterwards. */
      var payload = JSON.stringify({ version: 1, records: [{ id: 's-test', periodTo: '15/15/2020', periodFrom: '16/14/2020', total: 100, purchases: 100 }], ledger: [] });
      var f = new dom.window.File([payload], 'backup.json', { type: 'application/json' });
      f.text = function () { return Promise.resolve(payload); }; // jsdom File has no .text()
      Object.defineProperty(document.getElementById('openBundleInput'), 'files', { value: [f], configurable: true });
      document.getElementById('openBundleInput').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      setTimeout(function () {
        var now = dom.window.DATA;
        eq('bare-JSON bundle loaded (records replaced)', now.records.length, 1);
        eq('record id from JSON', now.records[0].id, 's-test');
        eq('ledger from JSON', now.ledger.length, 0);
        var saved2 = JSON.parse(dom.window.localStorage.getItem('ne.tracker.data'));
        eq('persisted bare-JSON bundle version (migrated)', saved2.version, 5);

        console.log('\n' + passed + ' passed, ' + failed + ' failed');
        process.exit(failed ? 1 : 0);
      }, 80);
    }, 60);
});
