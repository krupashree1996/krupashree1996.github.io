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
  setValue('#fIssue', '10/03/2026');
  setValue('#fMaturity', '28/05/2027');
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

  console.log('4b) complete read auto-imports (no confirm step)');
  var before = App.DATA.fds.length;
  App.autoImport({
    account: '130910DP00004004', holder: 'TEST HOLDER', pan: '', amount: 500000,
    rate: 8.1, issueDate: '2026-07-01', maturityDate: '2027-08-01', maturityValue: 551000,
    repayAc: '05582191003046', format: 'epos', complete: true
  }, 'Y_PNB_FD_20260701_4004_551000.pdf');
  eq('no modal opened for complete read', !!document.getElementById('importModal'), false);
  eq('FD added directly', App.DATA.fds.length, before + 1);
  eq('auto-imported account stored', App.DATA.fds[before].account, '130910DP00004004');
  eq('days computed', App.DATA.fds[before].days, 396);

  console.log('4c) importing the same slip twice is blocked (duplicate account)');
  // Re-run the exact same auto-import: same account number => duplicate, ignored.
  var beforeDup = App.DATA.fds.length;
  App.autoImport({
    account: '130910DP00004004', holder: 'TEST HOLDER', pan: '', amount: 500000,
    rate: 8.1, issueDate: '2026-07-01', maturityDate: '2027-08-01', maturityValue: 551000,
    repayAc: '05582191003046', format: 'epos', complete: true
  }, 'Y_PNB_FD_20260701_4004_551000.pdf');
  eq('no second FD created', App.DATA.fds.length, beforeDup);
  // Same slip via the preview path is also rejected and shows the error.
  App.importPreview({
    account: '130910DP00004004', holder: '', pan: '', amount: 500000,
    rate: 8.1, issueDate: '2026-07-01', maturityDate: '2027-08-01', maturityValue: 551000,
    repayAc: '05582191003046', format: 'epos', complete: true
  }, 'Y_PNB_FD_20260701_4004_551000.pdf');
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Add FD') b.click(); });
  eq('preview save blocked too', App.DATA.fds.length, beforeDup);
  eq('duplicate error shown', $('#importModal .err').textContent.indexOf('already in your list') >= 0, true);
  // Close the modal before opening the next one.
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Cancel') b.click(); });

  console.log('4d) import-preview flags a maturity/tenure year error');
  // The test slip: 390-day tenure + filename say 30 Dec 2026, printed maturity 30 Dec 2027.
  App.importPreview({
    account: '130910DP00004002', holder: 'TEST HOLDER', pan: '', amount: 400000,
    rate: 8, issueDate: '2025-12-05', maturityDate: '2027-12-30', maturityValue: 500000,
    days: 390, repayAc: '05582191003046', format: 'epos', complete: true
  }, 'Y_PNB_FD_20261230_4002_500000.pdf');
  eq('date/tenure warning shown', !!$('#importModal .dateWarn'), true);
  eq('warning mentions the year error', $('#importModal .dateWarn').textContent.indexOf('30 Dec 2027') >= 0, true);
  eq('warning suggests the fix', $('#importModal .dateWarn').textContent.indexOf('30 Dec 2026') >= 0, true);

  console.log('5) summary chips reflect totals');
  App.renderAll();
  var chips = $('#sumChips').textContent;
  eq('chip shows 3 FDs', chips.indexOf('3 FDs') >= 0, true);

  console.log('6) interest ledger modal — add payout, compound running');
  // Open the interest modal for the first FD (the one added in step 2).
  var fd0 = App.DATA.fds[0];
  App.buildInterestForm(fd0);
  eq('interest modal opened', !!$('#interestModal'), true);
  eq('mode selector present', !!$('#imMode'), true);
  eq('no payouts yet', !!$('#interestModal .muted'), true);

  // Malformed (mm/dd-shaped) date is rejected, not silently reinterpreted.
  setValue('#imDate', '08/13/2026');
  setValue('#imInt', '999');
  $$('#interestModal .actions button').forEach(function (b) { if (b.textContent === 'Add payout') b.click(); });
  eq('malformed date rejected', fd0.entries.length, 0);
  eq('malformed date shows error', $('#interestModal .err').textContent.indexOf('DD/MM/YYYY') >= 0, true);

  // Add two payouts (compound is the default).
  setValue('#imDate', '28/06/2026');
  setValue('#imInt', '8108');
  setValue('#imTax', '811');
  $$('#interestModal .actions button').forEach(function (b) { if (b.textContent === 'Add payout') b.click(); });
  setValue('#imDate', '24/09/2026');
  setValue('#imInt', '8282');
  setValue('#imTax', '829');
  $$('#interestModal .actions button').forEach(function (b) { if (b.textContent === 'Add payout') b.click(); });

  eq('two entries stored', fd0.entries.length, 2);
  eq('mode defaulted to compound', fd0.interestMode, 'compound');
  eq('table rendered with 2 rows', $$('#interestModal .intTable tr').length - 1, 2);
  // Compound running: first after = 400000 + (8108-811) = 407297.
  var rows = $$('#interestModal .intTable tr');
  eq('first row worth-after', rows[1].cells[5].textContent.indexOf('4,07,297') >= 0, true);
  // Row shows interest (paid) + worth now cells.
  App.renderAll();
  eq('row shows interest (paid) cell', $$('#sec-fd .fdCell').some(function (c) { return c.querySelector('small').textContent === 'Interest (paid)'; }), true);
  eq('summary shows interest received', $('#sec-fd .kv').textContent.indexOf('Interest (received)') >= 0, true);

  console.log('7) matured -> history (full record + XIRR); 1.5-FY removal');
  App.DATA.fds.push({
    id: 'fdOld', account: '130910DP00004005', panId: 'pan1',
    amount: 400000, rate: 8.1, issueDate: '2025-06-01', maturityDate: '2026-06-01',
    maturityValue: 440000, days: 365, interestMode: 'compound',
    entries: [{ date: '2025-09-28', int: 3060, tax: 306 }]
  });
  App.renderAll();
  var today = dom.window.Calc.todayISO();
  var fdOld = App.DATA.fds.filter(function (f) { return f.id === 'fdOld'; })[0];
  eq('matured FD visible before archive', $$('#sec-fd .fdRow').length, 4);
  eq('is matured', dom.window.Calc.fdStatus(fdOld, today), 'matured');
  eq('not yet past 1.5-FY cutoff', dom.window.Calc.fdAutoRemove(fdOld, today), false);
  App.archiveMatured(today);
  eq('matured FD moved to history', App.DATA.fds.length, 3);
  eq('archived row created (full record)', App.DATA.archived.length, 1);
  eq('archived keeps entries', App.DATA.archived[0].entries.length, 1);
  eq('archived has xirr', typeof App.DATA.archived[0].xirr, 'number');
  App.renderAll();
  eq('history card shown', !!$('#sec-fd .archTable'), true);
  eq('history row shows account', $('#sec-fd .archTable').textContent.indexOf('130910DP00004005') >= 0, true);
  eq('history row shows xirr %', $('#sec-fd .archTable').textContent.indexOf('% p.a.') >= 0, true);
  eq('payouts toggle present', !!$('#sec-fd .archTable button.mini'), true);
  // expanding shows the payout ledger
  $$('#sec-fd .archTable button.mini')[0].click();
  eq('detail row shows payout date', !!$('#sec-fd .archDetail:not([hidden])'), true);
  // 1.5-FY removal: FY 2026-27 maturity (01/06/2026) is removed from 1 Oct 2028
  eq('kept at 30 Sep 2028', dom.window.Calc.fdAutoRemove(App.DATA.archived[0], '2028-09-30'), false);
  eq('removed at 1 Oct 2028', dom.window.Calc.fdAutoRemove(App.DATA.archived[0], '2028-10-01'), true);
  eq('xirr chart rendered', !!$('#sec-fd .xirrSvg'), true);
  eq('chart has a line path', !!$('#sec-fd .xirrSvg path.line'), true);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
});
