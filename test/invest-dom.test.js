'use strict';
/* DOM integration test: boots the real investments/ app in jsdom and exercises
 * the FD form + import-preview paths through the actual UI.
 * Run: node test/invest-dom.test.js   (needs jsdom)
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

var html = fs.readFileSync(path.join(ROOT, 'investments', 'index.html'), 'utf8')
  .replace(/<script src="vendor\/pdf\.min\.js"><\/script>/, '')
  .replace(/<script src="calc\.js"><\/script>/, '')
  .replace(/<script src="fd\.js"><\/script>/, '')
  .replace(/<script src="data\/bundle\.js"><\/script>/, '')
  .replace(/<script src="app\.js"><\/script>/, '')
  .replace(/navigator\.serviceWorker\.register\('sw\.js'\)\.catch\(function \(\) \{\}\);/, '');

var dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/investments/', pretendToBeVisual: true });
var document = dom.window.document;
var calcSrc = fs.readFileSync(path.join(ROOT, 'investments', 'calc.js'), 'utf8');
var fdSrc = fs.readFileSync(path.join(ROOT, 'investments', 'fd.js'), 'utf8');
var bundleSrc = fs.readFileSync(path.join(ROOT, 'investments', 'data', 'bundle.js'), 'utf8');
var appSrc = fs.readFileSync(path.join(ROOT, 'investments', 'app.js'), 'utf8');
dom.window.eval(calcSrc);
dom.window.eval(fdSrc);
dom.window.eval(bundleSrc);
dom.window.eval(appSrc);

function whenReady(fn) {
  var t = setInterval(function () {
    if (dom.window.App && dom.window.Calc) { clearInterval(t); clearTimeout(to); fn(); }
  }, 10);
  var to = setTimeout(function () { clearInterval(t); console.log('FAIL timed out waiting for app boot'); process.exit(1); }, 5000);
}

whenReady(function run() {
  var App = dom.window.App;

  console.log('1) app boots, tabs + empty FD state');
  eq('App object exposed', !!App, true);
  eq('FD tab is current', $('#sec-fd').hidden, false);
  eq('Notes tab hidden', $('#sec-notes').hidden, true);
  eq('empty hint shown', !!$('#sec-fd .muted'), true);

  console.log('2) add FD form validation + save');
  // Seed a PAN holder so the holder dropdown exists.
  App.DATA.pans.push({ id: 'pan1', pan: 'ABCDE1234F', name: 'TEST NAME' });
  App.renderAll();
  $$('#sec-fd button.primary').forEach(function (b) { if (b.textContent === '+ Add FD') b.click(); });
  eq('FD form opened', !!$('#fAcc'), true);
  eq('holder dropdown present', !!$('#fPanId'), true);

  // Save with empty required fields -> error shown, no FD added.
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Add FD') b.click(); });
  eq('validation error shown', !!($('#modalBox .err') && $('#modalBox .err').textContent), true);
  eq('no FD added yet', App.DATA.fds.length, 0);

  // Fill and save.
  setValue('#fAcc', '130910DP00004001');
  setValue('#fAmt', '400000');
  setValue('#fRate', '8.1');
  setValue('#fIssue', '2026-03-10');
  setValue('#fMaturity', '2027-05-28');
  setValue('#fMv', '510000');
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Add FD') b.click(); });
  eq('modal closed after save', !document.getElementById('modal').classList.contains('open'), true);
  eq('one FD added', App.DATA.fds.length, 1);
  eq('fd account stored', App.DATA.fds[0].account, '130910DP00004001');
  eq('fd days auto-computed', App.DATA.fds[0].days, 444);

  console.log('3) FD row renders with computed values');
  eq('row rendered', $$('#sec-fd .fdRow').length, 1);
  eq('invested shown', !!$('#sec-fd .fdRow .fdCell b'), true);
  eq('active badge shown', $$('#sec-fd .badge.b-active').length, 1);

  console.log('4) import-preview path (synthetic parsed slip)');
  var parsed = {
    account: '130910DP00004003', holder: 'TEST HOLDER', pan: '', amount: 800000, days: 444,
    rate: 8.1, issueDate: '2026-03-24', maturityDate: '2027-06-11', maturityValue: 881991,
    repayAc: '05582191003046', format: 'epos', complete: true
  };
  App.importPreview(parsed, 'test.pdf');
  eq('import preview opened', !!$('#importModal'), true);
  eq('status ok banner', !!$('#importModal .parseStatus.ok'), true);
  eq('account prefilled', $('#fAcc').value, '130910DP00004003');
  eq('amount prefilled', $('#fAmt').value, '800000');
  // Save it.
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Add FD') b.click(); });
  eq('two FDs after import', App.DATA.fds.length, 2);

  console.log('5) summary chips reflect totals');
  App.renderAll();
  var chips = $('#sumChips').textContent;
  eq('chip shows 2 FDs', chips.indexOf('2 FDs') >= 0, true);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
});
