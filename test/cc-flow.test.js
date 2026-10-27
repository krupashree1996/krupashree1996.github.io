'use strict';
/* Import-flow regression test: a password-protected PDF must survive the
 * first (password-less) pdf.js attempt. pdf.js transfers the data buffer to
 * its worker, so a retry that reuses the same ArrayBuffer fails silently —
 * the app must hand pdf.js a fresh copy each time. Also covers re-prompting
 * after a wrong password instead of dead-ending, and that Home's
 * "Add N to ledger" actually books late-posted statement rows.
 * Run: node test/cc-flow.test.js (needs jsdom)
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
  'NeuCoins Summary',
  'Opening NeuCoins with Bank Total NeuCoins Earned (Base + Bonus) NeuCoins transferred to Tata Neu Adjusted/Lapsed Closing NeuCoins with Bank',
  '321 1,659 321 0 1,659',
  'Bonus NeuCoins Summary',
  'Sr No. Programs Bonus NeuCoins',
  '1 Base_Grocery 302',
  'Card Number 1234 56XX XXXX 7890'
];
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

var html = fs.readFileSync(path.join(ROOT, 'neu-tracker', 'index.html'), 'utf8')
  .replace(/<script src="[^"]+"><\/script>/g, '')
  .replace(/navigator\.serviceWorker\.register\('sw\.js'\)\.catch\(function \(\) \{\}\);/, '');
var dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/neu-tracker/', pretendToBeVisual: true });
var document = dom.window.document;

dom.window.__pdfText = tcOf(OLD_LINES);
dom.window.eval(`
window.__pdfCalls = [];
window.pdfjsLib = {
  GlobalWorkerOptions: {},
  getDocument: function (opts) {
    window.__pdfCalls.push({ pw: opts.password || '', bytes: opts.data ? opts.data.byteLength : -1 });
    if (opts.password !== 'secret') {
      /* pdf.js transfers the buffer to the worker, detaching the caller's copy */
      try { Object.defineProperty(opts.data, 'byteLength', { value: 0, configurable: true }); } catch (e) {}
      var err = new Error('Password required');
      err.name = 'PasswordException';
      err.code = opts.password ? 2 : 1;
      return { promise: Promise.reject(err) };
    }
    if (!opts.data || opts.data.byteLength === 0) {
      return { promise: Promise.reject(new Error('Invalid PDF structure.')) };
    }
    return { promise: Promise.resolve({
      numPages: 1,
      getPage: function () { return Promise.resolve({ getTextContent: function () { return Promise.resolve(window.__pdfText); } }); }
    }) };
  }
};
`);
dom.window.eval(fs.readFileSync(path.join(ROOT, 'neu-tracker', 'parser.js'), 'utf8'));
dom.window.eval(fs.readFileSync(path.join(ROOT, 'neu-tracker', 'calc.js'), 'utf8'));
dom.window.eval(fs.readFileSync(path.join(ROOT, 'neu-tracker', 'data', 'bundle.js'), 'utf8'));
dom.window.eval(fs.readFileSync(path.join(ROOT, 'neu-tracker', 'app.js'), 'utf8'));

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function waitFor(fn, ms) {
  return new Promise(function (resolve, reject) {
    var started = Date.now();
    (function poll() {
      if (fn()) return resolve();
      if (Date.now() - started > ms) return reject(new Error('timed out'));
      setTimeout(poll, 20);
    })();
  });
}
function importFake(name) {
  var inp = document.getElementById('importFile');
  var file = { name: name, arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(8)); } };
  Object.defineProperty(inp, 'files', { value: [file], configurable: true });
  inp.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}
function enterPassword(pw) {
  var inp = document.querySelector('#modalBox input');
  inp.value = pw;
  document.querySelector('#modalBox button').click();
}
function discard() { document.getElementById('discardBtn').click(); }

(async function run() {
  await waitFor(function () { return dom.window.App && document.querySelector('#cardBox select'); }, 10000);

  console.log('1) no stored password → prompt → retry uses a fresh buffer');
  importFake('statement.pdf');
  await waitFor(function () { return document.getElementById('modal').classList.contains('open'); }, 5000);
  ok('password modal opens after the password-less attempt', true);
  enterPassword('secret');
  await waitFor(function () { return document.getElementById('verify').style.display === 'block'; }, 5000);
  eq('verify view opened after unlocking', document.getElementById('verify').style.display, 'block');
  var calls = dom.window.__pdfCalls;
  eq('pdf.js called twice (no-pw, then unlock)', calls.length, 2);
  ok('second attempt carried the full PDF bytes', calls[1].bytes > 0);
  ok('verify title parsed', document.getElementById('verifyTitle').textContent.indexOf('18/03/2025') >= 0);
  discard();
  await wait(50);

  console.log('2) stored wrong password → re-prompt instead of dead-ending');
  dom.window.sessionStorage.setItem('ne.tracker.pw', 'wrong-password');
  dom.window.__pdfCalls = [];
  importFake('statement2.pdf');
  await waitFor(function () { return document.getElementById('modal').classList.contains('open'); }, 5000);
  ok('password modal re-opens after an incorrect stored password', true);
  enterPassword('secret');
  await waitFor(function () { return document.getElementById('verify').style.display === 'block'; }, 5000);
  eq('verify view opened after the corrected password', document.getElementById('verify').style.display, 'block');
  calls = dom.window.__pdfCalls;
  eq('pdf.js called twice (wrong stored pw, then corrected)', calls.length, 2);
  ok('corrected attempt carried the full PDF bytes', calls[1].bytes > 0);

  console.log('3) Add-to-ledger books a late-posted row without looping');
  var card = dom.window.DATA.cards.filter(function (c) { return c.id === dom.window.DATA.activeCardId; })[0];
  card.records = [
    { id: 's-prior', periodTo: '18/10/2025', periodFrom: '19/09/2025', total: 0, purchases: 0, reconciled: 'yes' },
    { id: 's-target', periodTo: '18/11/2025', periodFrom: '19/10/2025', total: 99, purchases: 99, closingNeuCoins: 0,
      txns: [{ date: '17/10/2025', desc: 'LATE FEE', amount: 99, credit: false }] }
  ];
  card.ledger = [];
  document.getElementById('homeGo').click();
  var addBtns = Array.from(document.querySelectorAll('#landingStats button')).filter(function (b) { return b.textContent.trim() === 'Add 1 to ledger'; });
  eq('Home offers to book the late-posted row', addBtns.length, 1);
  addBtns[0].click();
  eq('row is booked into the ledger', card.ledger.length, 1);
  eq('booked row is linked to its statement', card.ledger[0].sourcePeriod, '18/11/2025');
  eq('button disappears (row now matches)', Array.from(document.querySelectorAll('#landingStats button')).filter(function (b) { return /^Add \d+ to ledger$/.test(b.textContent.trim()); }).length, 0);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.log('FAIL ' + (e && e.message || e));
  process.exit(1);
});
