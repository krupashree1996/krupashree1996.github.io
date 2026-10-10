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
  eq('days cell shows tenure', ($$('#sec-fd .fdRow .fdCell')[2].textContent), 'Days444');

  console.log('3b) duplicate FD copies every field except the account number');
  App.DATA.fds[0].entries = [{ date: '2026-06-28', int: 8108, tax: 811 }];
  $$('#sec-fd .fdRow button').forEach(function (b) { if (b.textContent === 'duplicate') b.click(); });
  eq('duplicate form opened', !!$('#fAcc'), true);
  eq('duplicate title', !!($('#modalBox h2') && $('#modalBox h2').textContent === 'Duplicate FD'), true);
  eq('account left blank', $('#fAcc').value, '');
  eq('rate prefilled', $('#fRate').value, '8.1');
  eq('amount prefilled', $('#fAmt').value, '400000');
  eq('holder prefilled', $('#fPanId').value, 'pan1');
  eq('issue date prefilled from source', $('#fIssue').value, '10/03/2026');
  eq('maturity date prefilled from source', $('#fMaturity').value, '28/05/2027');
  setValue('#fAcc', '130910DP00004008');
  setValue('#fIssue', '15/04/2026');
  setValue('#fMaturity', '15/04/2028');
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Add FD') b.click(); });
  eq('duplicated FD added', App.DATA.fds.length, 2);
  var srcFd = App.DATA.fds[0];
  var dupFd = App.DATA.fds[1];
  eq('duplicated account is the new one', dupFd.account, '130910DP00004008');
  eq('duplicated FD copies payouts', JSON.stringify(dupFd.entries.map(function (e) { return [e.date, e.int]; })), JSON.stringify((srcFd.entries || []).map(function (e) { return [e.date, e.int]; })));
  eq('duplicated payouts are copies, not shared refs', dupFd.entries !== srcFd.entries, true);
  eq('duplicated FD keeps rate', dupFd.rate, 8.1);
  App.DATA.fds[0].entries = []; // step 6 expects fd0 to start with no payouts

  console.log('4) import-preview path (synthetic parsed slip)');
  var parsed = {
    account: '130910DP00004003', holder: 'TEST HOLDER', pan: '', amount: 800000, days: 444,
    rate: 8.1, issueDate: '2026-03-24', maturityDate: '2027-06-11', maturityValue: 881991,
    repayAc: '00000000000001', format: 'epos', complete: true
  };
  App.importPreview(parsed, 'test.pdf');
  eq('import preview opened', !!$('#importModal'), true);
  eq('status ok banner', !!$('#importModal .parseStatus.ok'), true);
  eq('account prefilled', $('#fAcc').value, '130910DP00004003');
  eq('amount prefilled', $('#fAmt').value, '800000');
  // Save it.
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Add FD') b.click(); });
  eq('three FDs after import', App.DATA.fds.length, 3);

  console.log('4b) complete read auto-imports (no confirm step)');
  var before = App.DATA.fds.length;
  App.autoImport({
    account: '130910DP00004004', holder: 'TEST HOLDER', pan: '', amount: 500000,
    rate: 8.1, issueDate: '2026-07-01', maturityDate: '2027-08-01', maturityValue: 600000,
    repayAc: '00000000000001', format: 'epos', complete: true
  }, 'Y_PNB_FD_20260701_4004_600000.pdf');
  eq('no modal opened for complete read', !!document.getElementById('importModal'), false);
  eq('FD added directly', App.DATA.fds.length, before + 1);
  eq('auto-imported account stored', App.DATA.fds[before].account, '130910DP00004004');
  eq('days computed', App.DATA.fds[before].days, 396);

  console.log('4c) importing the same slip twice is blocked (duplicate account)');
  // Re-run the exact same auto-import: same account number => duplicate, ignored.
  var beforeDup = App.DATA.fds.length;
  App.autoImport({
    account: '130910DP00004004', holder: 'TEST HOLDER', pan: '', amount: 500000,
    rate: 8.1, issueDate: '2026-07-01', maturityDate: '2027-08-01', maturityValue: 600000,
    repayAc: '00000000000001', format: 'epos', complete: true
  }, 'Y_PNB_FD_20260701_4004_600000.pdf');
  eq('no second FD created', App.DATA.fds.length, beforeDup);
  // Same slip via the preview path is also rejected and shows the error.
  App.importPreview({
    account: '130910DP00004004', holder: '', pan: '', amount: 500000,
    rate: 8.1, issueDate: '2026-07-01', maturityDate: '2027-08-01', maturityValue: 600000,
    repayAc: '00000000000001', format: 'epos', complete: true
  }, 'Y_PNB_FD_20260701_4004_600000.pdf');
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Add FD') b.click(); });
  eq('preview save blocked too', App.DATA.fds.length, beforeDup);
  eq('duplicate error shown', $('#importModal .err').textContent.indexOf('already in your list') >= 0, true);
  // Close the modal before opening the next one.
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Cancel') b.click(); });

  console.log('4d) import-preview flags a maturity/tenure year error');
  // The test slip (synthetic): 390-day tenure + filename say 30 Dec 2026, printed maturity 30 Dec 2027.
  App.importPreview({
    account: '130910DP00004002', holder: 'TEST HOLDER', pan: '', amount: 400000,
    rate: 8, issueDate: '2025-12-05', maturityDate: '2027-12-30', maturityValue: 500000,
    days: 390, repayAc: '00000000000001', format: 'epos', complete: true
  }, 'Y_PNB_FD_20261230_4002_500000.pdf');
  eq('date/tenure warning shown', !!$('#importModal .dateWarn'), true);
  eq('warning mentions the year error', $('#importModal .dateWarn').textContent.indexOf('30 Dec 2027') >= 0, true);
  eq('warning suggests the fix', $('#importModal .dateWarn').textContent.indexOf('30 Dec 2026') >= 0, true);

  console.log('5) summary chips reflect totals');
  App.renderAll();
  var chips = $('#sumChips').textContent;
  eq('chip shows 4 FDs', chips.indexOf('4 FDs') >= 0, true);

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

  // Re-adding the exact same payout (date + gross) is blocked.
  setValue('#imDate', '28/06/2026');
  setValue('#imInt', '8108');
  setValue('#imTax', '811');
  $$('#interestModal .actions button').forEach(function (b) { if (b.textContent === 'Add payout') b.click(); });
  eq('duplicate payout blocked', fd0.entries.length, 2);
  eq('duplicate error shown', $('#interestModal .err').textContent.indexOf('already recorded') >= 0, true);
  // A different amount on the same date is allowed.
  setValue('#imInt', '9999');
  $$('#interestModal .actions button').forEach(function (b) { if (b.textContent === 'Add payout') b.click(); });
  eq('different amount on same date allowed', fd0.entries.length, 3);
  // the modal also carries the estimated schedule table below the ledger, so count the first table only
  eq('ledger table rendered with 3 rows', $$('#interestModal table.intTable')[0].querySelectorAll('tr').length - 1, 3);

  // Edit an existing payout: pencil prefills the form, "Save changes" updates it.
  // Entries so far: 28/06 (8108, tds 811), 28/06 (9999), 24/09 (8282) — date-sorted,
  // so row 0 is the 28/06/8108 entry.
  var editBtns = $$('#interestModal .intTable button[title="Edit this payout"]');
  eq('pencil buttons present (one per row)', editBtns.length, 3);
  // No button inside the modal may be an implicit submit (it would navigate to '?').
  eq('no implicit submit buttons in the modal',
    $$('#interestModal form button').every(function (b) { return b.type === 'button'; }), true);
  editBtns[0].click();
  eq('save button switched to "Save changes"', $$('#interestModal .actions button').some(function (b) { return b.textContent === 'Save changes'; }), true);
  eq('date prefilled', $('#imDate').value, '28/06/2026');
  eq('gross prefilled', $('#imInt').value, '8108');
  // Change the gross and save.
  setValue('#imInt', '8200');
  $$('#interestModal .actions button').forEach(function (b) { if (b.textContent === 'Save changes') b.click(); });
  eq('entry count unchanged after edit', fd0.entries.length, 3);
  eq('gross updated to 8200', fd0.entries.some(function (e) { return e.date === '2026-06-28' && e.int === 8200; }), true);
  // Editing a row to another payout's date + gross is still flagged as a duplicate.
  var editBtns2 = $$('#interestModal .intTable button[title="Edit this payout"]');
  editBtns2[0].click(); // row 0 = 28/06, 8200
  setValue('#imDate', '24/09/2026'); // = the 8282 entry's date
  setValue('#imInt', '8282');
  $$('#interestModal .actions button').forEach(function (b) { if (b.textContent === 'Save changes') b.click(); });
  eq('edit collision still blocked', fd0.entries.length, 3);
  eq('collision error shown', $('#interestModal .err').textContent.indexOf('already recorded') >= 0, true);
  // Reset the row back to 28/06 / 8108 so the earlier "worth-after" assertion holds.
  var editBtns3 = $$('#interestModal .intTable button[title="Edit this payout"]');
  editBtns3[0].click();
  setValue('#imDate', '28/06/2026');
  setValue('#imInt', '8108');
  $$('#interestModal .actions button').forEach(function (b) { if (b.textContent === 'Save changes') b.click(); });

  // Compound running: first after = 400000 + (8108-811) = 407297.
  var rows = $$('#interestModal .intTable tr');
  eq('first row worth-after', rows[1].cells[5].textContent.indexOf('4,07,297') >= 0, true);
  // Row shows interest (paid) + worth now cells.
  App.renderAll();
  eq('row shows interest (paid) cell', $$('#sec-fd .fdCell').some(function (c) { return c.querySelector('small').textContent === 'Interest (paid)'; }), true);
  eq('summary shows FY interest tile', $('#sec-fd .kv').textContent.indexOf('interest') >= 0, true);
  eq('summary shows close now tile', $('#sec-fd .kv').textContent.indexOf('Close now') >= 0, true);

  console.log('7) matured -> history (full record + XIRR); 1.5-FY removal');
  App.DATA.fds.push({
    id: 'fdOld', account: '130910DP00004009', panId: 'pan1',
    amount: 400000, rate: 8.1, issueDate: '2025-06-01', maturityDate: '2026-06-01',
    maturityValue: 440000, days: 365, interestMode: 'compound',
    entries: [{ date: '2025-09-28', int: 3060, tax: 306 }]
  });
  App.renderAll();
  var today = dom.window.Calc.todayISO();
  var fdOld = App.DATA.fds.filter(function (f) { return f.id === 'fdOld'; })[0];
  eq('matured FD visible before archive', $$('#sec-fd .fdRow').length, 5);
  eq('is matured', dom.window.Calc.fdStatus(fdOld, today), 'matured');
  eq('not yet past 1.5-FY cutoff', dom.window.Calc.fdAutoRemove(fdOld, today), false);
  App.archiveMatured(today);
  eq('matured FD moved to history', App.DATA.fds.length, 4);
  eq('archived row created (full record)', App.DATA.archived.length, 1);
  eq('archived keeps entries', App.DATA.archived[0].entries.length, 1);
  eq('archived has xirr', typeof App.DATA.archived[0].xirr, 'number');
  App.renderAll();
  eq('history card shown', !!$('#sec-fd .archTable'), true);
  eq('history row shows account', $('#sec-fd .archTable').textContent.indexOf('130910DP00004009') >= 0, true);
  eq('history row shows xirr %', $('#sec-fd .archTable').textContent.indexOf('% p.a.') >= 0, true);
  eq('history row has duplicate button', $$('#sec-fd .archTable button').filter(function (b) { return b.textContent === 'duplicate'; }).length >= 1, true);
  eq('history TDS cell carries FY tooltip', (function () { var tds = $('#sec-fd .archTable tr:nth-child(2) td:nth-child(6)'); return tds && tds.title && tds.title.indexOf('financial year') >= 0; })(), true);

  console.log('7b) a history record can be edited in place (e.g. fill a missing maturity value)');
  (function () {
    var oldRow = $$('#sec-fd .archTable tr').filter(function (tr) { return tr.textContent.indexOf('130910DP00004009') >= 0; })[0];
    Array.from(oldRow.querySelectorAll('button.mini')).forEach(function (b) { if (b.textContent === 'edit') b.click(); });
  })();
  eq('history edit form opened', !!($('#modalBox h2') && $('#modalBox h2').textContent === 'Edit FD (history)'), true);
  eq('history edit prefills account', $('#fAcc').value, '130910DP00004009');
  setValue('#fMv', '440000');
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Save changes') b.click(); });
  var edited = App.DATA.archived.filter(function (a) { return a.account === '130910DP00004009'; })[0];
  eq('history edit saved in place', edited.maturityValue, 440000);
  eq('history edit refreshed XIRR', typeof edited.xirr, 'number');

  eq('payouts toggle present', !!$('#sec-fd .archTable button.mini'), true);
  // expanding shows the payout ledger (the "payouts" button, not the new "interest" one)
  $$('#sec-fd .archTable button.mini').forEach(function (b) { if (b.textContent === 'payouts') b.click(); });
  eq('detail row shows payout date', !!$('#sec-fd .archDetail:not([hidden])'), true);
  // 1.5-FY removal: FY 2026-27 maturity (01/06/2026) is removed from 1 Oct 2028
  eq('kept at 30 Sep 2028', dom.window.Calc.fdAutoRemove(App.DATA.archived[0], '2028-09-30'), false);
  eq('removed at 1 Oct 2028', dom.window.Calc.fdAutoRemove(App.DATA.archived[0], '2028-10-01'), true);
  eq('xirr chart rendered', !!$('#sec-fd .xirrSvg'), true);
  eq('chart has a line path', !!$('#sec-fd .xirrSvg path.line'), true);
  // With a realistic ~8% XIRR the y-axis must fit the data (e.g. 5..8) instead
  // of forcing a 0 baseline.
  App.DATA.archived[0].xirr = 0.081;
  App.renderAll();
  eq('chart y-axis fits the data (no forced 0 baseline)', (function () {
    var labels = $$('#sec-fd .xirrSvg text.ax').map(function (t) { return t.textContent; })
      .filter(function (s) { return /^\d+(\.\d+)?$/.test(s); });
    var nums = labels.map(Number);
    return nums.length > 0 && Math.min.apply(null, nums) > 0;
  })(), true);

  console.log('8) freshly-matured FD is still editable (final payout on maturity day)');
  var arch = App.DATA.archived[0];
  eq('archived record flagged as matured-on-load', !!arch.isMatured, true);
  eq('matured row has an interest button', $$('#sec-fd .archTable button.mini').some(function (b) { return b.textContent === 'interest'; }), true);
  // The final (maturity-day) payout can be recorded from the history table.
  $$('#sec-fd .archTable button.mini').forEach(function (b) { if (b.textContent === 'interest') b.click(); });
  eq('interest modal opened for matured FD', !!$('#interestModal'), true);
  setValue('#imDate', '01/06/2026');
  setValue('#imInt', '3060');
  setValue('#imTax', '306');
  $$('#interestModal .actions button').forEach(function (b) { if (b.textContent === 'Add payout') b.click(); });
  eq('final payout stored on the archived record', arch.entries.length, 2);
  eq('final payout is the maturity-day one', arch.entries.some(function (e) { return e.date === '2026-06-01' && e.int === 3060; }), true);
  eq('archived XIRR refreshed', typeof arch.xirr, 'number');
  eq('matured FD row still shows the payout total', $('#sec-fd .archTable').textContent.indexOf('3,060') >= 0, true);
  // Older archived records (matured long before they were archived) stay read-only.
  App.DATA.archived.push({
    id: 'archOld', account: '130910DP00004006', panId: 'pan1',
    amount: 200000, rate: 7, issueDate: '2024-06-01', maturityDate: '2025-06-01',
    maturityValue: 214000, xirr: 0.07, archivedAt: '2025-07-15',
    entries: [{ date: '2025-06-01', int: 14000, tax: 0 }]
  });
  // A record archived in a PREVIOUS version on its own maturity day (no isMatured
  // flag, archivedAt === maturityDate) must still be editable — that is exactly
  // today's situation for the user's FD.
  App.DATA.archived.push({
    id: 'archToday', account: '130910DP00004007', panId: 'pan1',
    amount: 300000, rate: 7.5, issueDate: '2025-09-01', maturityDate: today,
    maturityValue: 310000, xirr: 0.075, archivedAt: today, entries: []
  });
  App.renderAll();
  eq('history sorted by latest maturity first', (function () {
    var accts = $$('#sec-fd .archTable tr').slice(1).map(function (tr) {
      var m = tr.textContent.match(/130910DP\d+/); return m ? m[0] : null;
    }).filter(Boolean).join(',');
    return accts === '130910DP00004007,130910DP00004009,130910DP00004006';
  })(), true);
  eq('unflagged archive row has no interest button (read-only)',
    (function () {
      var rows = $$('#sec-fd .archTable tr');
      var oldRow = rows.filter(function (tr) { return tr.textContent.indexOf('130910DP00004006') >= 0; })[0];
      return oldRow && !Array.from(oldRow.querySelectorAll('button.mini')).some(function (b) { return b.textContent === 'interest'; });
    })(), true);
  eq('flagged row still has its interest button',
    (function () {
      var rows = $$('#sec-fd .archTable tr');
      var newRow = rows.filter(function (tr) { return tr.textContent.indexOf('130910DP00004009') >= 0; })[0];
      return newRow && Array.from(newRow.querySelectorAll('button.mini')).some(function (b) { return b.textContent === 'interest'; });
    })(), true);

  console.log('9) date fields: calendar picker + manual typing');
  App.buildFdForm(null);
  eq('issue date wrapped with calendar button', !!$('.dateinWrap input#fIssue ~ .dateCalBtn'), true);
  // Tapping the calendar button opens a month grid next to the field.
  $('.dateinWrap input#fIssue ~ .dateCalBtn').click();
  eq('calendar popup open', !!$('#calPop'), true);
  var days = $$('#calPop .calDay');
  eq('day cells rendered', days.length >= 28, true);
  // Tapping a day writes DD/MM/YYYY into the field and closes the popup.
  var day15 = days.filter(function (d) { return d.textContent === '15'; })[0];
  day15.click();
  var now = new Date();
  var mm = (now.getMonth() < 9 ? '0' : '') + (now.getMonth() + 1);
  eq('picked day is 15th of current month (padded DD/MM/YYYY)', $('#fIssue').value, '15/' + mm + '/' + now.getFullYear());
  eq('popup closed after pick', !$('#calPop'), true);
  // Manual typing still works (DD/MM/YYYY text field).
  setValue('#fIssue', '10/03/2026');
  eq('typed date kept as-is', $('#fIssue').value, '10/03/2026');
  // Calendar reopens anchored to the typed value's month.
  $('.dateinWrap input#fIssue ~ .dateCalBtn').click();
  eq('reopened on typed month (03/26)', $$('#calPop .calLabel')[0].textContent, '3/26');
  eq('typed 10th highlighted', $$('#calPop .calDay.sel').some(function (d) { return d.textContent === '10'; }), true);
  closeDatePickerViaBtn();
  function closeDatePickerViaBtn() { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }
  eq('escape closes popup', !$('#calPop'), true);
  closeModalViaApp();
  function closeModalViaApp() { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }

  console.log('10) holder resync links records to PANs after load');
  App.DATA.pans.push({ id: 'panR', pan: 'ABCD01234F', name: 'RESYNC HOLDER' });
  var fdA = { account: '130910DP00004010', panId: '', pan: 'abcd01234f', holder: '', amount: 1000, rate: 7, issueDate: '01/04/2026', maturityDate: '01/04/2027' };
  var fdB = { account: '130910DP00004011', panId: 'stale-id', pan: 'ABCD01234F', holder: 'old label', amount: 1000, rate: 7, issueDate: '01/04/2026', maturityDate: '01/04/2027' };
  App.DATA.fds.push(fdA, fdB);
  App.resyncHolders();
  eq('empty panId linked by PAN text', fdA.panId, 'panR');
  eq('holder name filled from holder', fdA.holder, 'RESYNC HOLDER');
  eq('stale panId re-linked by PAN text', fdB.panId, 'panR');
  eq('holder label refreshed', fdB.holder, 'RESYNC HOLDER');
  App.DATA.fds.push({ account: '130910DP00004012', panId: 'pan1', pan: '', holder: '', amount: 1, rate: 1, issueDate: '01/04/2026', maturityDate: '01/04/2027' });
  App.resyncHolders();
  eq('valid panId kept', App.DATA.fds[App.DATA.fds.length - 1].panId, 'pan1');
  App.DATA.fds.pop();
  App.DATA.fds.pop(); App.DATA.fds.pop();
  App.DATA.pans.pop();

  console.log('11) FD type field + SCSS/RBI auto-payout & TDS 0');
  App.buildFdForm(null);
  eq('type select present', !!$('#fType'), true);
  setValue('#fType', 'scss');
  setValue('#fAcc', 'SCSS99990001');
  setValue('#fAmt', '1000000');
  setValue('#fRate', '8.2');
  setValue('#fIssue', '01/06/2026');
  setValue('#fMaturity', '01/06/2031');
  var scssBtn = $$('#modalBox .actions button').filter(function (b) { return b.textContent === 'Add FD'; })[0];
  scssBtn.click();
  var scss = App.DATA.fds.filter(function (f) { return f.account === 'SCSS99990001'; })[0];
  eq('scss added', !!scss, true);
  eq('scss stored type', scss.type, 'scss');
  eq('scss forced to payout mode', scss.interestMode, 'payout');
  eq('scss TDS defaulted to 0', scss.tdsRate, 0);
  eq('scss row shows SCSS badge', $$('#sec-fd .fdRow').some(function (r) { return r.querySelector('.b-type') && r.querySelector('.b-type').textContent === 'SCSS'; }), true);
  // The "Expected total" cell for the SCSS row must be the principal (₹10,00,000),
  // NOT P + simple interest (which would be ~₹14,34,xxx).
  var scssRow = $$('#sec-fd .fdRow').filter(function (r) { return r.getAttribute('data-account') === 'SCSS99990001'; })[0];
  var expCell = Array.prototype.slice.call(scssRow.querySelectorAll('.fdCell')).filter(function (c) { return c.querySelector('small') && c.querySelector('small').textContent === 'Expected total'; })[0];
  eq('scss expected total = principal only', expCell.querySelector('b').textContent, '₹10,00,000');

  console.log('12) commodities tab — add SGB holding + coupon');
  App.switchTab('commodities');
  eq('commodities section visible', $('#sec-commodities').hidden, false);
  eq('commodities empty hint', !!$('#sec-commodities .muted'), true);
  // Add via the form.
  $$('#sec-commodities button').forEach(function (b) { if (b.textContent === '+ Add holding') b.click(); });
  eq('commodity form opened', !!$('#cName'), true);
  setValue('#cName', 'SGB 2026');
  setValue('#cCost', '120000');
  setValue('#cUnits', '24');
  setValue('#cPrice', '7000');
  setValue('#cPurchase', '01/06/2025');
  setValue('#cValuedOn', '20/09/2026');
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Add holding') b.click(); });
  var c0 = App.DATA.commodities[0];
  eq('commodity added', !!c0, true);
  eq('commodity name', c0.name, 'SGB 2026');
  eq('commodity row rendered', $$('#sec-commodities .intTable tr').length >= 2, true);
  // Record a coupon.
  var cpBtn = $$('#sec-commodities table button').filter(function (b) { return b.textContent === 'coupon'; })[0];
  cpBtn.click();
  eq('coupon form opened', !!$('#cpAmt'), true);
  setValue('#cpDate', '01/12/2025');
  setValue('#cpAmt', '1500');
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Add coupon') b.click(); });
  eq('coupon recorded', App.DATA.commodities[0].coupons.length, 1);
  eq('coupon amount', App.DATA.commodities[0].coupons[0].amount, 1500);
    // Persisted through bundle round-trip shape.
  eq('commodities in DATA', Array.isArray(App.DATA.commodities), true);

  console.log('12b) SGB redemption date + coupon estimate schedule');
  // The SGB form shows the maturity/coupon fields by default (kind = sgb).
  $$('#sec-commodities button').forEach(function (b) { if (b.textContent === '+ Add holding') b.click(); });
  var redeemLabel = $('#cRedeem').parentNode.parentNode;
  var rateLabel = $('#cRate').parentNode.parentNode;
  eq('sgb fields shown for sgb', redeemLabel.style.display, '');
  setValue('#cName', 'SGB 2024 (TEST)');
  setValue('#cKind', 'gold');
  eq('sgb fields hidden for gold', redeemLabel.style.display, 'none');
  setValue('#cKind', 'sgb');
  eq('sgb fields shown again', redeemLabel.style.display, '');
  setValue('#cCost', '50104');
  setValue('#cUnits', '50');
  setValue('#cRate', '2.5');
  setValue('#cPurchase', '21/02/2024');
  setValue('#cRedeem', '21/02/2032');
  setValue('#cValuedOn', '04/10/2026');
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Add holding') b.click(); });
  var sgb0 = App.DATA.commodities.filter(function (c) { return c.name === 'SGB 2024 (TEST)'; })[0];
  eq('sgb added', !!sgb0, true);
  eq('redeemDate stored', sgb0.redeemDate, '2032-02-21');
  eq('couponRate stored', sgb0.couponRate, 2.5);
  // row shows the Est. payout cell
  var sgbRow = Array.prototype.slice.call(document.querySelectorAll('#sec-commodities tr')).filter(function (r) { return r.textContent.indexOf('SGB 2024 (TEST)') >= 0; })[0];
  eq('sgb row found', !!sgbRow, true);
  var estTds = Array.prototype.slice.call(sgbRow.querySelectorAll('td')).filter(function (t) { return t.title && t.title.indexOf('Estimated coupon + redemption schedule') >= 0; });
  eq('Est. payout cell on sgb row', estTds.length >= 1, true);
  eq('estimate shows face redemption', estTds[0].title.indexOf('₹50,000') >= 0, true);
  eq('estimate lists a coupon date', estTds[0].title.indexOf('21 Aug 2024') >= 0, true);
  // coupon modal renders the schedule table
  var cpBtn2 = Array.prototype.slice.call(sgbRow.querySelectorAll('button')).filter(function (b) { return b.textContent === 'coupon'; })[0];
  cpBtn2.click();
  var schedTbls = $$('#modalBox table.intTable');
  eq('schedule table in coupon modal', schedTbls.length >= 1, true);
  var stText = schedTbls[schedTbls.length - 1].textContent;
  eq('schedule has first coupon', stText.indexOf('21 Aug 2024') >= 0, true);
  eq('schedule marks redemption (face)', stText.indexOf('redemption (face)') >= 0, true);
  eq('schedule has estimated total', stText.indexOf('estimated total') >= 0, true);
  // close the modal
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Cancel') b.click(); });

  console.log('13) SCSS payout-estimate fields + schedule display');
  App.switchTab('fd');
  App.buildFdForm(null);
  eq('estimate fields hidden for FD', $('#fEstFull').parentNode.style.display, 'none');
  setValue('#fType', 'scss');
  eq('estimate fields shown for SCSS', $('#fEstFull').parentNode.style.display, '');
  setValue('#fAcc', '130910SC00004020');
  setValue('#fAmt', '1000000');
  setValue('#fRate', '8.2');
  setValue('#fIssue', '19/02/2026');
  setValue('#fMaturity', '18/02/2031');
  setValue('#fEstStart', '9211');
  setValue('#fEstEnd', '11289');
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Add FD') b.click(); });
  var sc2 = App.DATA.fds.filter(function (f) { return f.account === '130910SC00004020'; })[0];
  eq('scss2 added', !!sc2, true);
  eq('brokenStart stored', sc2.payoutEstimate && sc2.payoutEstimate.brokenStart, 9211);
  eq('brokenEnd stored', sc2.payoutEstimate && sc2.payoutEstimate.brokenEnd, 11289);
  eq('full left blank (auto P*r/4)', sc2.payoutEstimate && sc2.payoutEstimate.full, null);
  // row shows the next estimated payout
  var sc2Row = $$('#sec-fd .fdRow').filter(function (r) { return r.getAttribute('data-account') === '130910SC00004020'; })[0];
  var estCell = Array.prototype.slice.call(sc2Row.querySelectorAll('.fdCell')).filter(function (c) { return c.querySelector('small') && c.querySelector('small').textContent === 'Est. payout'; })[0];
  eq('Est. payout cell on row', !!estCell, true);
  eq('estimate tooltip lists schedule', estCell.title.indexOf('31 Mar 2026') >= 0, true);
  eq('estimate tooltip has total', estCell.title.indexOf('Estimated total gross') >= 0, true);
  eq('estimate tooltip uses bank broken start', estCell.title.indexOf('₹9,211') >= 0, true);
  eq('estimate tooltip uses P*r/4 full quarter', estCell.title.indexOf('₹20,500') >= 0, true);
  // interest modal renders the schedule table
  App.buildInterestForm(sc2);
  var modTables = $$('#interestModal table.intTable');
  eq('schedule table present in interest modal', modTables.length >= 1, true);
  var schedTbl = modTables[modTables.length - 1];
  var schedText = schedTbl.textContent;
  eq('schedule has first quarter end', schedText.indexOf('31 Mar 2026') >= 0, true);
  eq('schedule marks broken start', schedText.indexOf('broken start') >= 0, true);
  eq('schedule marks broken end', schedText.indexOf('broken end') >= 0, true);
  eq('schedule shows estimated total', schedText.indexOf('estimated total') >= 0, true);
  eq('schedule row count (21 periods)', schedTbl.querySelectorAll('tr').length - 1, 22); // 21 + total row
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Close') b.click(); });
  // FD keeps hiding the estimate fields
  App.buildFdForm(null);
  eq('estimate fields hidden again for FD', $('#fEstFull').parentNode.style.display, 'none');
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Cancel') b.click(); });

  console.log('14) FD quarterly estimates (compound credited in / payout paid out)');
  // compound FD: estimate fields stay hidden (nothing to confirm), row shows value at maturity
  App.buildFdForm(null);
  eq('compound FD hides estimate fields', $('#fEstFull').parentNode.style.display, 'none');
  setValue('#fAcc', '999999DP99999901');
  setValue('#fAmt', '400000');
  setValue('#fRate', '8.1');
  setValue('#fIssue', '20/02/2026');
  setValue('#fMaturity', '19/06/2028');
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Add FD') b.click(); });
  var cfd = App.DATA.fds.filter(function (f) { return f.account === '999999DP99999901'; })[0];
  eq('compound FD added', !!cfd, true);
  eq('compound FD stores no payoutEstimate', cfd.payoutEstimate, null);
  var cfdRow = $$('#sec-fd .fdRow').filter(function (r) { return r.getAttribute('data-account') === '999999DP99999901'; })[0];
  var cfdCell = Array.prototype.slice.call(cfdRow.querySelectorAll('.fdCell')).filter(function (c) { return c.querySelector('small') && c.querySelector('small').textContent === 'Est. at maturity'; })[0];
  eq('Est. at maturity cell on compound row', !!cfdCell, true);
  eq('compound tooltip mentions credited in', cfdCell.title.indexOf('credited in') >= 0, true);
  eq('compound tooltip has maturity value line', cfdCell.title.indexOf('Estimated value at maturity') >= 0, true);
  // interest modal shows the running-value schedule
  App.buildInterestForm(cfd);
  var cTbls = $$('#interestModal table.intTable');
  eq('compound schedule table in interest modal', cTbls.length >= 1, true);
  var cTbl = cTbls[cTbls.length - 1];
  var cText = cTbl.textContent;
  cTbl.querySelectorAll('th').forEach(function (th) { if (th.textContent === 'Worth after') eq('compound schedule has Worth after column', true, true); });
  eq('compound schedule marks broken start', cText.indexOf('broken start') >= 0, true);
  eq('compound schedule marks final period', cText.indexOf('final period') >= 0, true);
  eq('compound schedule totals value at maturity', cText.indexOf('value at maturity') >= 0, true);
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Close') b.click(); });
  // payout FD: estimate fields appear when interest type = payout
  App.buildFdForm(null);
  setValue('#fType', 'fd');
  setValue('#fImode', 'payout');
  eq('payout FD shows estimate fields', $('#fEstFull').parentNode.style.display, '');
  setValue('#fImode', 'compound');
  eq('compound FD hides estimate fields again', $('#fEstFull').parentNode.style.display, 'none');
  $$('#modalBox .actions button').forEach(function (b) { if (b.textContent === 'Cancel') b.click(); });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
});
