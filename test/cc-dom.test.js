'use strict';
/* DOM integration test: boots the real neu-tracker/ app in jsdom and verifies
 * the Rewards and Bills views, ledger/redemption/payment data flows, and the
 * schema-v2 bundle. Scripts are injected manually since jsdom cannot fetch
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

  console.log('1) boot — schema v2 bundle migrated on load');
  eq('data version 2', DATA.version, 2);
  ok('redemptions array', Array.isArray(DATA.redemptions));
  ok('payments array', Array.isArray(DATA.payments));
  eq('coin value default', DATA.rewardsConfig.valuePerCoin, 0.25);
  ok('landing section present', !!$('#landing'));

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

  console.log('5) bills view');
  $('#billsGo').click();
  eq('bills visible', $('#bills').style.display, 'block');
  eq('due board empty state', $('#blDue').textContent.indexOf('No statements yet') >= 0, true);
  eq('interest empty state', $('#blInterest').textContent.indexOf('No statements yet') >= 0, true);

  console.log('6) reconcile engine against the in-app ledger');
  DATA.records.push({ id: 's-1', periodTo: '18/11/2025', periodFrom: '19/10/2025', total: 200, minimumDue: 10, prevDues: 0, payments: 0, purchases: 200, finance: 0, creditLimit: 100000, availLimit: 99800, dueDate: '08/12/2025', earnedNeuCoins: 3, transferredNeuCoins: 0, openingNeuCoins: 0, adjustedNeuCoins: 0, closingNeuCoins: 3, bonusPrograms: [{ program: 'Base_Grocery', coins: 3 }], txns: [{ date: '10/11/2025', desc: 'DMART', amount: 200, credit: false, base: 0 }] });
  $('#rewardsGo').click();
  eq('cycle breakdown expected grocery', $('#rwCycle').textContent.indexOf('expected +3') >= 0, true);
  eq('redeem reconcile shows net −97 (3 earned − 0 transferred − 100 redeemed)', $('#rwReconcile').textContent.indexOf('more redeemed than earned') >= 0 && $('#rwReconcile').textContent.indexOf('-97') >= 0, true);
  $('#billsGo').click();
  eq('due board row rendered', $('#blDue').textContent.indexOf('due 08/12/2025') >= 0, true);

  console.log('7) persistence round-trip');
  var saved = JSON.parse(dom.window.localStorage.getItem('ne.tracker.data'));
  eq('persisted version', saved.version, 2);
  eq('persisted ledger entries', saved.ledger.length, 1);
  eq('persisted redemptions', saved.redemptions.length, 1);
  ok('no password persisted', !('password' in saved));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});