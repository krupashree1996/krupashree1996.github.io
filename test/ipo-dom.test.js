'use strict';
/* DOM integration test: boots the real ipo/ app in jsdom (scripts injected manually
 * since jsdom cannot fetch file:// siblings) and verifies the default-lots
 * behaviour through the actual UI (IPO form, apply modal, app form).
 * Run: node test/ipo-dom.test.js   (needs jsdom; set NODE_PATH to a jsdom install)
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
function $(sel, doc) { return (doc || document).querySelector(sel); }
function $$(sel, doc) { return Array.from((doc || document).querySelectorAll(sel)); }
function setValue(sel, v, doc) {
  var e = $(sel, doc);
  e.value = v;
  e.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  e.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

var html = fs.readFileSync(path.join(ROOT, 'ipo', 'index.html'), 'utf8')
  .replace(/<script src="calc\.js"><\/script>/, '')
  .replace(/<script src="data\/bundle\.js"><\/script>/, '')
  .replace(/<script src="app\.js"><\/script>/, '')
  .replace(/navigator\.serviceWorker\.register\('sw\.js'\)\.catch\(function \(\) \{\}\);/, '');

var dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/ipo/', pretendToBeVisual: true });
var document = dom.window.document;
var calcSrc = fs.readFileSync(path.join(ROOT, 'ipo', 'calc.js'), 'utf8');
var bundleSrc = fs.readFileSync(path.join(ROOT, 'ipo', 'data', 'bundle.js'), 'utf8');
var appSrc = fs.readFileSync(path.join(ROOT, 'ipo', 'app.js'), 'utf8');
document.body.innerHTML = document.body.innerHTML; // noop
dom.window.eval(calcSrc);
dom.window.eval(bundleSrc);
dom.window.eval(appSrc);

function whenReady(fn) {
  var t = setInterval(function () {
    if (dom.window.App && dom.window.Calc) { clearInterval(t); fn(); }
  }, 10);
  setTimeout(function () { clearInterval(t); console.log('FAIL timed out waiting for app boot'); process.exit(1); }, 5000);
}

whenReady(function run() {
  var App = dom.window.App;

  console.log('1) IPO form — mainline min lots default');
  $$('#sec-cal button.primary').forEach(function (b) { if (b.textContent === '+ Add IPO') b.click(); });
  eq('IPO form opened', !!$('#iName'), true);
  eq('mainline default min lots = 1', $('#iMin').value, '1');

  setValue('#iHi', '1000');
  setValue('#iLot', '10');
  setValue('#iCategory', 'SME');
  eq('SME default min lots = 20 (₹10,000/lot × 20 = ₹2,00,000)', $('#iMin').value, '20');

  setValue('#iHi', '200');
  eq('SME after price change → 100 lots', $('#iMin').value, '100');

  setValue('#iMin', '7');
  setValue('#iCategory', 'Mainline');
  eq('touched min lots preserved on category switch', $('#iMin').value, '7');

  setValue('#iMin', '100');
  setValue('#iName', 'SmeCo');
  setValue('#iSymbol', 'SMCO');
  setValue('#iHi', '200');
  setValue('#iLot', '10');
  setValue('#iCategory', 'SME');
  setValue('#iOpen', '2026-09-01');
  setValue('#iClose', '2026-09-08');
  $$('#modalBox button.primary').forEach(function (b) { if (b.textContent === 'Add IPO') b.click(); });
  eq('SME ipo saved', App.DATA.ipos.length, 1);
  eq('saved minLots = 100', App.DATA.ipos[0].minLots, 100);

  $$('#sec-cal button.primary').forEach(function (b) { if (b.textContent === '+ Add IPO') b.click(); });
  setValue('#iName', 'MainCo');
  setValue('#iSymbol', 'MAIN');
  setValue('#iHi', '500');
  setValue('#iLot', '5');
  setValue('#iCategory', 'Mainline');
  eq('mainline min lots = 1 in form', $('#iMin').value, '1');
  $$('#modalBox button.primary').forEach(function (b) { if (b.textContent === 'Add IPO') b.click(); });
  eq('mainline ipo saved', App.DATA.ipos.length, 2);
  var main = App.DATA.ipos.find(function (i) { return i.symbol === 'MAIN'; });
  eq('saved mainline minLots = 1', main.minLots, 1);

  console.log('2) IPO calendar row — shares shown use new defaults');
  App.renderAll();
  var smeRow = $$('#sec-cal .ipoRow').filter(function (r) { return r.getAttribute('data-symbol') === 'SMCO'; })[0];
  var mainRow = $$('#sec-cal .ipoRow').filter(function (r) { return r.getAttribute('data-symbol') === 'MAIN'; })[0];
  eq('SME row shows "100 lots"', (smeRow.textContent.match(/Shares \(([^)]+)\)/) || [])[1], '100 lots');
  eq('mainline row shows "1 lot"', (mainRow.textContent.match(/Shares \(([^)]+)\)/) || [])[1], '1 lot');
  eq('SME row total value ₹2,00,000', !!smeRow.textContent.match(/₹2,00,000/), true);
  eq('mainline row total value ₹2,500', !!mainRow.textContent.match(/₹2,500/), true);

  console.log('3) Apply modal — one-lot mainline, hundred-lot SME');
  App.DATA.pans.push({ id: 'pan-1', pan: 'ABCDE1234F', name: 'K' });
  App.renderAll();
  $$('.ipoRow').filter(function (r) { return r.getAttribute('data-symbol') === 'MAIN'; })[0]
    .querySelectorAll('button').forEach(function (b) { if (b.textContent === '+ app') b.click(); });
  eq('apply modal opened', !!document.getElementById('panCkpan-1'), true);
  var hint = $$('#modalBox p.hint')[0] ? $$('#modalBox p.hint')[0].textContent : '';
  eq('apply hint shows "1 lot = ₹2,500"', hint.indexOf('1 lot = ₹2,500') >= 0, true);
  document.getElementById('panCkpan-1').click();
  var tot = document.getElementById('applyTot').textContent;
  eq('apply total 1 app · lien ₹2,500', tot, 'Adds 1 application · total lien ₹2,500');
  $$('#modalBox button.primary').forEach(function (b) { if (b.textContent === 'Apply') b.click(); });
  var appRec = App.DATA.applications[0];
  eq('application recorded', !!appRec, true);
  eq('applied lots = 1 (mainline)', appRec.lots, 1);
  eq('applied price = 500', appRec.price, 500);

  console.log('4) Application form — default lots follow category');
  document.querySelector('#tabs [data-tab="apps"]').click();
  $$('#sec-apps button.primary').forEach(function (b) { if (b.textContent === '+ Apply IPO') b.click(); });
  eq('app form default lots = 1', $('#aLots').value, '1');
  setValue('#aIpo', App.DATA.ipos[0].id);
  eq('switching to SME default lots = 100', $('#aLots').value, '100');
  eq('SME lien preview = ₹2,00,000', $$('#modalBox .lienmini span')[0].textContent.indexOf('₹2,00,000') >= 0, true);

  console.log('5) Edit IPO form — stored min lots preserved (not auto-overwritten)');
  $$('#sec-cal .ipoRow').filter(function (r) { return r.getAttribute('data-symbol') === 'SMCO'; })[0]
    .querySelectorAll('button').forEach(function (b) { if (b.textContent === 'edit') b.click(); });
  eq('edit form min lots = stored 100', $('#iMin').value, '100');
  setValue('#iHi', '5000');
  setValue('#iCategory', 'SME');
  eq('stored min lots kept on price change (user value wins)', $('#iMin').value, '100');
  $$('#modalBox button.ghost').forEach(function (b) { if (b.textContent === 'Cancel') b.click(); });

  console.log('6) localStorage persistence round-trip (flush is debounced 250ms)');
  setTimeout(function () {
  var saved = JSON.parse(dom.window.localStorage.getItem('ipo.tracker.session'));
  eq('persisted applications', saved.applications.length, 1);
  eq('persisted mainline minLots', saved.ipos.find(function (i) { return i.symbol === 'MAIN'; }).minLots, 1);
  eq('persisted sme minLots', saved.ipos.find(function (i) { return i.symbol === 'SMCO'; }).minLots, 100);

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  }, 300);
});

