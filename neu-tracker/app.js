/* HDFC Tata Neu Credit Card Tracker — app.
 * Import encrypted statement PDFs (password kept on-device only), verify the
 * printed amounts + NeuCoins against the built-in formulas, keep a manual
 * expense ledger, reconcile each statement against it. Fully offline.
 */
(function () {
  'use strict';
  var App = {};
  var pdfjsLib = window.pdfjsLib;
  var Parser = window.Parser;
  var Calc = window.Calc;

  if (!pdfjsLib || !Parser || !Calc) {
    document.body.insertAdjacentHTML('beforeend', '<div class="err">Missing lib (lib/pdf.min.js, parser.js, calc.js).</div>');
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

  var STORE_KEY = 'ne.tracker.data';
  var PW_KEY = 'ne.tracker.pw';
  var APP_VERSION = 2;

  /* ---------------- tiny DOM helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function statChip(label, count) {
    var d = el('div', 'stat', label + ' ');
    d.appendChild(el('b', '', String(count)));
    return d;
  }
  function fmtMoney(x) { return Calc.fmtMoney(x); }
  function fmtNum(x) { return Calc.fmtNum(x); }
  function fmtCoins(x) { return Calc.fmtCoins(x); }
  function fmtDate(d) { return d || '—'; }
  function toast(msg, kind) {
    var t = el('div', 'toast ' + (kind || 'ok'));
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, 4000);
  }
  function modal(node, open) {
    $('modalBox').replaceChildren();
    if (open && node) $('modalBox').appendChild(node);
    $('modal').classList.toggle('open', !!open);
    if (open) {
      var f = $('modalBox').querySelector('button, input, select, [tabindex], a');
      if (f) f.focus();
    }
  }
  function closeModal() { modal(null, false); }
  $('modal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  function saveFile(name, text, mime) {
    var b = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function download(name, text, mime) { saveFile(name, text, mime || 'application/octet-stream'); }

  function show(id) {
    ['landing', 'verify', 'ledger', 'reconcile', 'rewards'].forEach(function (x) {
      var n = $(x);
      if (!n) return;
      n.style.display = (x === id ? 'block' : 'none');
    });
  }

  /* ---------------- state ---------------- */
  var DATA = null;      // migrated copy of window.DATA / localStorage
  var S = { st: null, checks: null, decisions: {}, curRecord: null, recId: null, rwRec: null, chartB: null, chartC: null, autoScheduled: false, committed: false, autoTimer: null };
  var importing = false;

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(DATA));
      window.DATA = DATA;
    } catch (e) { toast('Could not save to browser storage.', 'bad'); }
  }
  function loadData() {
    var raw = null;
    try { var s = localStorage.getItem(STORE_KEY); if (s) raw = JSON.parse(s); } catch (e) { raw = null; }
    if (!raw) raw = window.DATA || { version: 1, records: [], ledger: [] };
    var m = Calc.migrateBundle(raw);
    if (m.incompatible) { toast('Saved bundle is from a newer app version — update the app.', 'bad'); return; }
    DATA = m;
    window.DATA = m;
  }
  /* Session-only: lives in sessionStorage — survives reloads of this tab,
   * wiped when the browser (or tab) closes. Never in localStorage. */
  function getPw() { try { return sessionStorage.getItem(PW_KEY) || ''; } catch (e) { return ''; } }
  function setPw(p) { try { if (p) sessionStorage.setItem(PW_KEY, p); else sessionStorage.removeItem(PW_KEY); } catch (e) { } }

  /* ---------------- import / parse ---------------- */
  function readPdf(ab, pw) {
    var task = pdfjsLib.getDocument({ data: ab, password: pw || undefined, isEvalSupported: false });
    return task.promise.then(function (doc) {
      var pages = [];
      for (var p = 1; p <= doc.numPages; p++) pages.push(doc.getPage(p).then(function (page) { return page.getTextContent(); }));
      return Promise.all(pages).then(function (tcs) {
        /* pdf.js hands back per-page coordinates that restart on every page, so
         * stack pages vertically (page 1 on top) before the parser groups lines. */
        var items = [];
        tcs.forEach(function (tc, i) {
          var off = (tcs.length - i) * 10000;
          ((tc && tc.items) || []).forEach(function (it) {
            if (!it || !it.str || !it.str.trim()) return;
            var t = it.transform || [1, 0, 0, 1, 0, 0];
            items.push({ str: it.str, width: it.width || 0, transform: [t[0], t[1], t[2], t[3], t[4], t[5] + off] });
          });
        });
        return { items: items };
      });
    });
  }
  function askPassword(cb) {
    var box = el('div');
    box.appendChild(el('h2', '', 'Statement password'));
    box.appendChild(el('p', 'muted', 'Unlock this statement PDF. Your password is kept only for this browser session (sessionStorage) and is wiped when you close the browser — it is never saved to disk, bundle.js or the repo.'));
    var row = el('div', 'form');
    var inp = el('input'); inp.type = 'password'; inp.placeholder = 'PDF password'; inp.autocomplete = 'current-password';
    row.appendChild(inp);
    box.appendChild(row);
    var ok = el('button', '', 'Unlock');
    ok.onclick = function () {
      var pw = inp.value;
      setPw(pw);
      closeModal();
      cb(pw);
    };
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok.click(); });
    box.appendChild(el('div', 'form'));
    box.lastChild.appendChild(ok);
    modal(box, true);
    setTimeout(function () { inp.focus(); }, 30);
  }

  function importFile(file) {
    if (!/\.pdf$/i.test(file.name)) { toast('Please choose a PDF statement.', 'warn'); return; }
    importing = true;
    $('importHint').textContent = 'Reading ' + file.name + '… (offline)';
    file.arrayBuffer().then(function (ab) {
      var attempt = function (pw) {
        return readPdf(ab, pw).then(function (tc) {
          var st = Parser.parseStatement(tc);
          var importOK = isFinite(st.total) && st.total > 0;
          openVerify(st);
          return !importOK;
        });
      };
      attempt(getPw()).catch(function (e) {
        if (e && e.name === 'PasswordException') {
          if (e.code === 2) { toast('Incorrect password.', 'bad'); return; }
          askPassword(function (pw) {
            attempt(pw).catch(function (e2) {
              toast((e2 && e2.message) || 'Could not open this PDF.', 'bad');
            });
          });
        } else {
          toast((e && e.message) || 'Could not read this PDF.', 'bad');
        }
      }).then(function () { importing = false; $('importHint').textContent = ''; });
    }, function () { importing = false; toast('Could not read the file.', 'bad'); });
  }

  /* ---------------- verification view ---------------- */
  function kvRow(l, v) {
    var d = el('div');
    var b = el('b', '', l);
    d.appendChild(b);
    d.appendChild(el('span', '', v));
    return d;
  }
  function kvBox(st) {
    var box = el('div', 'kv');
    box.appendChild(kvRow('Period', fmtDate(st.periodFrom ? st.periodFrom + ' → ' + st.periodTo : st.periodTo)))
    box.appendChild(kvRow('Due date', fmtDate(st.dueDate)));
    box.appendChild(kvRow('Total due', fmtMoney(st.total)));
    box.appendChild(kvRow('Minimum due', fmtMoney(st.minimumDue)));
    box.appendChild(kvRow('Purchases', fmtMoney(st.purchases)));
    box.appendChild(kvRow('Payments', fmtMoney(st.payments)));
    box.appendChild(kvRow('Finance', fmtMoney(st.finance)));
    box.appendChild(kvRow('Opening NeuCoins', fmtCoins(st.openingNeuCoins)));
    box.appendChild(kvRow('Earned (Base+Bonus)', fmtCoins(st.earnedNeuCoins)));
    box.appendChild(kvRow('Transferred', fmtCoins(st.transferredNeuCoins)));
    box.appendChild(kvRow('Adjusted/Lapsed', fmtCoins(st.adjustedNeuCoins)));
    box.appendChild(kvRow('Closing NeuCoins', fmtCoins(st.closingNeuCoins)));
    return box;
  }
  function checkRow(c, onAccept, onRaise) {
    var row = el('div', 'check');
    row.appendChild(el('span', 'st ' + c.status));
    var lbl = el('span', 'lbl', c.label);
    if (c.message) lbl.appendChild(el('div', 'meta', c.message));
    else {
      var parts = '';
      if (c.expected != null) parts += 'expected ' + (typeof c.expected === 'string' ? c.expected : fmtNum(c.expected));
      if (c.actual != null) parts += (parts ? ', ' : '') + 'got ' + (typeof c.actual === 'string' ? c.actual : fmtNum(c.actual));
      if (c.delta != null) parts += (parts ? ', ' : '') + 'Δ ' + (c.delta === 0 ? '0' : fmtNum(c.delta));
      if (c.ref) parts += (parts ? ', ' : '') + c.ref;
      if (parts) lbl.appendChild(el('div', 'meta', parts));
    }
    row.appendChild(lbl);
    var badge = el('span', 'badge ' + c.status, (c.status === 'accepted' ? 'accepted' : c.status));
    row.appendChild(badge);
    if ((c.status === 'fail' || c.status === 'warn') && !S.decisions[c.key]) {
      var btns = el('div', 'btns');
      var a = el('button', '', 'It’s okay');
      var b = el('button', 'danger', 'Raise concern');
      a.onclick = function () { onAccept(c.key); };
      b.onclick = function () { onRaise(c.key, c); };
      btns.appendChild(a); btns.appendChild(b);
      row.appendChild(btns);
    }
    return row;
  }
  function renderChecks() {
    var box = el('div', 'checks');
    var pending = [];
    S.checks.forEach(function (c) {
      box.appendChild(checkRow(c, acceptCheck, raiseCheck));
      if ((c.status === 'fail' || c.status === 'warn') && !S.decisions[c.key]) pending.push(c.label);
    });
    var p = el('div', 'pending');
    p.textContent = pending.length ? 'Decide on ' + pending.length + ' flagged item(s) to continue.' : 'All checked.';
    $('checksBox').replaceChildren(box, p);
    $('commitBtn').disabled = pending.length > 0;
    $('raiseNote').textContent = Object.keys(S.decisions).length
      ? Object.keys(S.decisions).map(function (k) { return k + ' ✓'; }).join(', ') : 'no exceptions yet';
    if (S.autoTimer) { clearInterval(S.autoTimer); S.autoTimer = null; }
    if (!pending.length && S.st && !S.autoScheduled) {
      /* every check passed (or was accepted) — record automatically after a
       * short, visible countdown so the checks can be read first. */
      S.autoScheduled = true;
      p.textContent = 'All checks passed — recording automatically in 15s.';
      var left = 15;
      S.autoTimer = setInterval(function () {
        if (S.committed) { clearInterval(S.autoTimer); S.autoTimer = null; return; }
        if ($('verify').style.display !== 'block') { clearInterval(S.autoTimer); S.autoTimer = null; return; }
        left -= 1;
        if (left <= 0) {
          clearInterval(S.autoTimer); S.autoTimer = null;
          if (!S.committed) commitStatement(true);
        } else {
          p.textContent = 'All checks passed — recording automatically in ' + left + 's.';
        }
      }, 1000);
    }
  }
  function acceptCheck(key) {
    S.decisions[key] = 'accepted by user';
    renderChecks();
  }
  function raiseCheck(key, c) {
    var box = el('div');
    box.appendChild(el('h2', '', 'Raise concern'));
    box.appendChild(el('p', 'muted', 'Note the problem and it stays on the record for your reference (still countable as accepted).'));
    var ta = el('textarea');
    ta.placeholder = 'e.g. includes an EMI I am tracking separately…';
    box.appendChild(ta);
    var ok = el('button', '', 'Save note');
    ok.onclick = function () {
      S.decisions[key] = (ta.value || 'concern noted by user');
      closeModal();
      renderChecks();
    };
    box.appendChild(el('div', 'form'));
    box.lastChild.appendChild(ok);
    modal(box, true);
    setTimeout(function () { ta.focus(); }, 30);
  }

  function bonusChips(st) {
    var box = el('div', 'chips');
    (st.bonusPrograms || []).forEach(function (p) {
      var chip = el('span', 'chip', p.program + ' ');
      chip.appendChild(el('b', '', fmtCoins(p.coins)));
      box.appendChild(chip);
    });
    return box;
  }

  function prevRecordOf(rec) {
    var sorted = DATA.records.filter(function (r) { return r !== rec; }).sort(function (a, b) {
      return (Calc.pdate(a.periodTo) || 0) - (Calc.pdate(b.periodTo) || 0);
    });
    for (var i = sorted.length - 1; i >= 0; i--) if ((Calc.pdate(sorted[i].periodTo) || 0) < (Calc.pdate(rec.periodTo) || 0)) return sorted[i];
    return null;
  }

  function openVerify(st) {
    S.st = st;
    S.autoScheduled = false;
    S.committed = false;
    if (S.autoTimer) { clearInterval(S.autoTimer); S.autoTimer = null; }
    var dup = DATA.records.filter(function (r) { return r.periodTo === st.periodTo; })[0];
    S.curRecord = dup || null;
    if (dup) toast('A record for this period already exists — verifying again will replace it.', 'warn');
    var v = Calc.verifyStatement(st, { prevRecord: prevRecordOf(dup || { periodTo: st.periodTo }) || (DATA.records.length ? DATA.records[DATA.records.length - 1] : null), cardNo: DATA.card.no });
    S.checks = v.checks;
    S.decisions = {};
    $('verifyTitle').textContent = 'Verify ' + (st.periodTo || st.statementDate) + ' statement';
    $('verifyKv').replaceChildren(kvBox(st));
    $('bonusChips').replaceChildren(bonusChips(st));
    var dSum = 0, cSum = 0;
    (st.txns || []).forEach(function (t) { if (t.credit) cSum += t.amount; else dSum += t.amount; });
    $('txnCount').textContent = (st.txns || []).length + ' transactions · debit ' + fmtMoney(dSum) +
      ' · credit ' + fmtMoney(cSum);
    renderChecks();
    show('verify');
  }

  function buildRecord() {
    var st = S.st;
    return {
      id: 's-' + st.periodTo.replace(/\//g, ''),
      layout: st.layout, statementDate: st.statementDate,
      periodFrom: st.periodFrom, periodTo: st.periodTo, dueDate: st.dueDate,
      cardNo: st.cardNo, aan: st.aan, name: st.name,
      total: st.total, minimumDue: st.minimumDue, prevDues: st.prevDues,
      payments: st.payments, purchases: st.purchases, finance: st.finance,
      creditLimit: st.creditLimit, availLimit: st.availLimit, availCash: st.availCash,
      openingNeuCoins: st.openingNeuCoins, earnedNeuCoins: st.earnedNeuCoins,
      transferredNeuCoins: st.transferredNeuCoins, adjustedNeuCoins: st.adjustedNeuCoins,
      closingNeuCoins: st.closingNeuCoins,
      bonusPrograms: st.bonusPrograms, bonusTotal: st.bonusTotal, txns: st.txns,
      accepted: Object.keys(S.decisions).map(function (k) { return { key: k, note: S.decisions[k] }; }),
      status: 'verified',
      /* re-importing a recorded period must not wipe its reconciled flag or
       * previously noted exceptions */
      reconciled: S.curRecord && S.curRecord.reconciled ? S.curRecord.reconciled : ''
    };
  }
  function commitStatement(auto) {
    S.committed = true;
    var rec = buildRecord();
    var i = DATA.records.findIndex(function (r) { return r.id === rec.id; });
    if (i >= 0) DATA.records[i] = rec; else DATA.records.push(rec);
    DATA.records.sort(function (a, b) { return (Calc.pdate(a.periodTo) || 0) - (Calc.pdate(b.periodTo) || 0); });
    /* importing this statement proves the previous bill's dues were paid →
     * auto-record that payment so the old bill shows 'settled'. */
    if (Calc.autoSettlePrior(DATA.records, DATA.payments, rec) > 0) {
      toast('Previous bill marked paid (auto).', 'ok');
    }
    persist();
    toast(auto ? 'All checks passed — statement recorded automatically for ' + (rec.periodTo || rec.statementDate) + '.' : 'Statement recorded for ' + (rec.periodTo || rec.statementDate) + '.', 'ok');
    show('landing');
    renderAll();
    /* auto-reconcile when the ledger fully matches the bill (nothing unmatched on
     * either side) → home. Otherwise the user must close the cycle out: stay on
     * the reconcile page until they click "Mark as reconciled (anyway)". */
    var res = Calc.reconcile(rec, DATA.ledger, prevRecordOf(rec));
    if (!rec.reconciled && res.matchedCount > 0 && !res.bookOnlyCount && !res.stmtOnlyCount) {
      markReconciled(rec, res);
      return;
    }
    setTimeout(function () { openReconcile(rec); }, 60);
  }

  /* ---------------- ledger ---------------- */
  function todayStr() {
    var d = new Date();
    return [pad(d.getDate()), pad(d.getMonth() + 1), d.getFullYear()].join('/');
  }
  function pad(n) { return String(n).length === 1 ? '0' + n : String(n); }

  function renderCategoryOptions(sel) {
    sel.replaceChildren();
    Object.keys(Calc.CATEGORIES).forEach(function (k) {
      var c = Calc.CATEGORIES[k];
      var o = el('option', '', c.label + ' · ' + c.note);
      o.value = k;
      sel.appendChild(o);
    });
  }
  function hintFor(cat) {
    var c = Calc.CATEGORIES[cat];
    return c ? c.label + ': ' + c.note + (c.rate ? ' → ' + Math.round(c.rate * 100) + '%' : '') : '';
  }
  function addEntry() {
    var date = $('leDate').value, desc = $('leDesc').value.trim(), cat = $('leCat').value;
    var amount = parseFloat(String($('leAmt').value).replace(/[, ]/g, ''));
    if (!date) { toast('Date required.', 'warn'); return; }
    if (!desc) { toast('Description required.', 'warn'); return; }
    if (!isFinite(amount) || amount <= 0) { toast('Amount must be a positive number.', 'warn'); return; }
    DATA.ledger.push({
      id: 'e-' + Date.now().toString(36),
      date: date, desc: desc, category: cat, amount: Math.round(amount * 100) / 100, reconciled: ''
    });
    persist();
    renderLedger();
    $('leDesc').value = '';
    $('leAmt').value = '';
  }
  function delEntry(id) {
    DATA.ledger = DATA.ledger.filter(function (e) { return e.id !== id; });
    persist();
    renderLedger();
  }
  function ledgerEntryRow(e) {
    var row = el('div', 'lrow');
    var guess = e.guess ? (Calc.CATEGORIES[e.guess] ? Calc.CATEGORIES[e.guess].label : '') : '';
    row.appendChild(el('span', 'l-date', fmtDate(e.date)));
    var d = el('span', 'l-desc', e.desc);
    if (guess && guess !== Calc.CATEGORIES[e.category].label) d.appendChild(el('span', 'meta', ' guessed ' + guess));
    row.appendChild(d);
    var p = Calc.predictedCoins(e);
    row.appendChild(el('span', 'l-cat', Calc.CATEGORIES[e.category].label + (p.coins ? ' +' + fmtCoins(p.coins) : '')));
    var amt = el('span', 'l-amt', fmtMoney(e.category === 'payment' ? -e.amount : e.amount));
    if (e.reconciled) amt.appendChild(el('span', 'tick', ' ✓ reconciled'));
    row.appendChild(amt);
    var del = el('button', 'danger small', '✕');
    del.title = 'Delete this entry';
    del.onclick = function () { delEntry(e.id); };
    row.appendChild(del);
    return row;
  }
  function renderLedger() {
    var cats = {};
    var groups = {};
    var byCat = { upi: 0, grocery: 0, base: 0, tata: 0, nocoins: 0, payment: 0 };
    DATA.ledger.forEach(function (e) {
      /* dates are dd/mm/yyyy → group key "yyyy-mm" (e.g. "2025-12"); string
       * sort on that key is chronological across year boundaries too.
       * Entries within a month are re-sorted below by real timestamp. */
       var mk = e.date.slice(6, 10) + '-' + e.date.slice(3, 5); // "yyyy-mm"
      if (groups[mk] == null) groups[mk] = [];
      groups[mk].push(e);
      byCat[e.category] = (byCat[e.category] || 0) + (e.category === 'payment' ? -e.amount : e.amount);
    });
    $('ledgerTotals').replaceChildren();
    var totBox = el('div', 'ktotals');
    Object.keys(Calc.CATEGORIES).forEach(function (k) {
      var c = Calc.CATEGORIES[k];
      var d = el('div', 'k');
      d.appendChild(el('b', '', c.label));
      d.appendChild(el('span', '', fmtMoney(byCat[k] || 0)));
      totBox.appendChild(d);
    });
    $('ledgerTotals').appendChild(totBox);
    $('ledgerList').replaceChildren();
    var months = Object.keys(groups).sort().reverse();
    months.forEach(function (m) {
      var mnames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var h = el('div', 'lg-h', mnames[+m.slice(5) - 1] + ' ' + m.slice(0, 4));
      $('ledgerList').appendChild(h);
      groups[m].slice().sort(function (a, b) { return (Calc.pdate(b.date) || 0) - (Calc.pdate(a.date) || 0); }).forEach(function (e) {
        $('ledgerList').appendChild(ledgerEntryRow(e));
      });
    });
    if (!months.length) $('ledgerList').appendChild(el('p', 'muted', 'No entries yet. Add your card spends here and reconcile each statement after importing it.'));
    renderPayments();
  }

  /* ---------------- reconcile ---------------- */
  function renderRecordOptions(sel) {
    sel.replaceChildren();
    if (!DATA.records.length) {
      var o = el('option', '', 'No statements imported yet');
      sel.appendChild(o);
      return;
    }
    DATA.records.slice().sort(function (a, b) { return (Calc.pdate(b.periodTo) || 0) - (Calc.pdate(a.periodTo) || 0); }).forEach(function (r) {
      var o = el('option', '', r.periodTo + (r.reconciled ? ' ✓ reconciled' : '') + ' · ' + fmtMoney(r.total));
      o.value = r.periodTo;
      sel.appendChild(o);
    });
  }
  function pickRecord(periodTo) {
    return DATA.records.filter(function (r) { return r.periodTo === periodTo; })[0] || null;
  }
  function openReconcile(rec) {
    if (rec) {
      var sel = $('rcSel');
      renderRecordOptions(sel);
      sel.value = rec.periodTo;
    }
    renderReconcile();
    show('reconcile');
  }
  /* Book every "on statement, not in ledger" row into the ledger (payments as
   * Payment · 0 coins, spends guessed by merchant). Shared by the Reconcile
   * page and Home so the user can bulk-book a recorded statement from
   * anywhere — not only while sitting on the Reconcile screen. Returns the
   * number of ledger entries added. If the bill now fully matches, it
   * auto-reconciles (→ home); otherwise the current view is refreshed. */
  function bookStmtOnly(rec) {
    var res = Calc.reconcile(rec, DATA.ledger, prevRecordOf(rec));
    /* count-based dedupe: a statement can carry N identical rows (same
     * day + amount + merchant). Book exactly as many ledger entries as there
     * are statement rows, and no more — so re-clicking never duplicates, and
     * every identical row can be matched. */
    var want = {}; // key -> number of statement-only rows
    res.stmtOnly.forEach(function (tx) {
      var k = tx.date + '|' + Math.round(tx.amount * 100) / 100 + '|' + tx.desc;
      want[k] = (want[k] || 0) + 1;
    });
    var have = {}; // key -> entries already in the ledger
    DATA.ledger.forEach(function (e) {
      var k = e.date + '|' + Math.round((e.amount || 0) * 100) / 100 + '|' + e.desc;
      if (want[k]) have[k] = (have[k] || 0) + 1;
    });
    var added = 0;
    res.stmtOnly.forEach(function (tx) {
      var k = tx.date + '|' + Math.round(tx.amount * 100) / 100 + '|' + tx.desc;
      if ((have[k] || 0) >= want[k]) return; // this key is already fully booked
      DATA.ledger.push({
        id: 'e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        date: tx.date, desc: tx.desc,
        category: Calc.guessCategory(tx),
        amount: Math.round(tx.amount * 100) / 100, reconciled: '',
        /* which statement this row came from — lets the NEXT statement's
         * reconcile ignore it as "not on statement" (its date may fall in that
         * window without belonging to it) */
        sourcePeriod: rec.periodTo
      });
      have[k] = (have[k] || 0) + 1;
      added++;
    });
    persist();
    renderLedger();
    /* re-run reconcile and follow the usual path: if the bill now fully
     * matches, auto-reconcile and return home; else refresh the current view. */
    var res2 = Calc.reconcile(rec, DATA.ledger, prevRecordOf(rec));
    if (!rec.reconciled && res2.matchedCount > 0 && !res2.bookOnlyCount && !res2.stmtOnlyCount) {
      markReconciled(rec, res2);
      return added;
    }
    renderAll();
    toast(added ? 'Added ' + added + ' ledger entries from the statement.' : 'No new entries — every row is already booked.', 'ok');
    return added;
  }
  function renderReconcile() {
    var sel = $('rcSel');
    renderRecordOptions(sel);
    var rec = pickRecord(sel.value);
    if (!rec) { $('rcBody').replaceChildren(el('p', 'muted', 'Import a statement first, then reconcile it against your ledger.')); return; }
    var res = Calc.reconcile(rec, DATA.ledger, prevRecordOf(rec));
    S.recId = rec.id;
    var body = el('div');
    var head = el('div', 'kv');
    head.appendChild(kvRow('Statement', fmtDate(rec.periodTo)));
    head.appendChild(kvRow('Window', fmtDate(res.windowFrom || rec.periodFrom) + ' → ' + fmtDate(res.windowTo)));
    body.appendChild(head);

    var stats = el('div', 'stats');
    stats.appendChild(statChip('Matched', res.matchedCount));
    stats.appendChild(statChip('Ledger only', res.bookOnlyCount));
    stats.appendChild(statChip('Statement only', res.stmtOnlyCount));
    body.appendChild(stats);

    if (res.matched.length) {
      body.appendChild(el('h4', '', 'Matched (' + res.matched.length + ')'));
      var m = el('div', 'table');
      res.matched.forEach(function (x) {
        var r = el('div', 'lrow');
        r.appendChild(el('span', 'l-date', fmtDate(x.entry.date)));
        r.appendChild(el('span', 'l-desc', x.entry.desc + ' — ' + x.txn.desc));
        r.appendChild(el('span', 'l-cat', Calc.CATEGORIES[x.entry.category].label));
        r.appendChild(el('span', 'l-amt', fmtMoney(x.entry.amount)));
        m.appendChild(r);
      });
      body.appendChild(m);
    }
    if (res.bookOnly.length) {
      body.appendChild(el('h4', '', 'In ledger, not on statement — check these'));
      var b2 = el('div', 'table');
      res.bookOnly.forEach(function (e) {
        var r = el('div', 'lrow');
        r.appendChild(el('span', 'l-date', fmtDate(e.date)));
        r.appendChild(el('span', 'l-desc', e.desc));
        r.appendChild(el('span', 'l-cat', Calc.CATEGORIES[e.category].label + (Calc.predictedCoins(e).coins ? ' +' + fmtCoins(Calc.predictedCoins(e).coins) : '')));
        r.appendChild(el('span', 'l-amt', fmtMoney(e.amount)));
        b2.appendChild(r);
      });
      body.appendChild(b2);
    }
    if (res.stmtOnly.length) {
      body.appendChild(el('h4', '', 'On statement, not in ledger (' + res.stmtOnly.length + ')'));
      var s = el('div', 'table');
      res.stmtOnly.forEach(function (tx) {
        var r = el('div', 'lrow');
        r.appendChild(el('span', 'l-date', fmtDate(tx.date)));
        r.appendChild(el('span', 'l-desc', tx.desc));
        r.appendChild(el('span', 'l-cat', tx.credit ? 'Payment' : (Calc.classifyMerchant(tx.desc, tx.credit) === 'upi' ? 'UPI' : '?') + ' (not booked)'));
        r.appendChild(el('span', 'l-amt', fmtMoney(tx.amount)));
        s.appendChild(r);
      });
      body.appendChild(s);
      var addAll = el('button', '', 'Add all ' + res.stmtOnly.length + ' to ledger');
      addAll.title = 'Book every statement-only row into the ledger (payments as Payment · 0 coins, spends guessed by merchant). Review categories in the Ledger afterwards.';
      addAll.onclick = function () { bookStmtOnly(rec); };
      body.appendChild(el('div', 'form'));
      body.lastChild.appendChild(addAll);
    }
    if (Math.abs(Calc.round2(res.payInBook) - Calc.round2(res.payInStmt)) > 0.02) {
      body.appendChild(el('div', 'pending', 'Payment amounts differ: ledger ' + fmtMoney(res.payInBook) + ' vs statement ' + fmtMoney(res.payInStmt) + '.'));
    }

    body.appendChild(el('h4', '', 'NeuCoins — expected vs statement'));
    var keys = Object.keys(res.expected);
    var coinBox = el('div', 'table');
    if (!keys.length) coinBox.appendChild(el('p', 'muted', 'No coin-earning entries in this window.'));
    keys.forEach(function (k) {
      var exp = res.expected[k];
      var act = res.actual[k] != null ? res.actual[k] : 0;
      var r = el('div', 'lrow');
      r.appendChild(el('span', 'l-desc', k + (k === 'Add_TataPayment' ? ' (bonus lands next statement)' : '')));
      r.appendChild(el('span', 'l-cat', 'expected +' + fmtCoins(exp)));
      r.appendChild(el('span', 'l-amt', (act === exp ? '✓ ' : '≠ ') + 'statement ' + fmtCoins(act)));
      coinBox.appendChild(r);
    });
    body.appendChild(coinBox);
    if (!res.matchedCount && !res.bookOnlyCount && !res.stmtOnlyCount) body.appendChild(el('p', 'muted', 'Nothing in this window — check your window or add entries.'));

    if (!rec.reconciled) {
      var go = el('button', '', res.bookOnlyCount || res.stmtOnlyCount ? 'Mark as reconciled anyway' : 'Mark this statement reconciled');
      go.onclick = function () {
        markReconciled(rec, res);
      };
      body.appendChild(el('div', 'form'));
      body.lastChild.appendChild(go);
    } else {
      body.appendChild(el('div', 'pending', 'This statement is marked reconciled.'));
    }
    $('rcBody').replaceChildren(body);
  }
  function markReconciled(rec, res) {
    res.matched.forEach(function (x) { x.entry.reconciled = rec.periodTo; });
    rec.reconciled = new Date().toLocaleString('en-IN');
    persist();
    toast('Reconciled ' + rec.periodTo + ' — ' + res.matchedCount + ' entries matched.', 'ok');
    renderLedger();
    show('landing');
    renderAll();
  }

  /* ---------------- rewards ---------------- */
  function rwCycleOptions() {
    var sel = $('rwSel');
    sel.replaceChildren();
    if (!DATA.records.length) { sel.appendChild(el('option', '', 'No statements yet')); return; }
    var sorted = DATA.records.slice().sort(function (a, b) { return (Calc.pdate(b.periodTo) || 0) - (Calc.pdate(a.periodTo) || 0); });
    sorted.forEach(function (r) {
      var o = el('option', '', r.periodTo + (isFinite(r.earnedNeuCoins) ? ' · +' + fmtCoins(r.earnedNeuCoins) : ''));
      o.value = r.periodTo;
      sel.appendChild(o);
    });
    if (S.rwRec && DATA.records.some(function (r) { return r.periodTo === S.rwRec; })) sel.value = S.rwRec;
    else { sel.value = sorted[0].periodTo; S.rwRec = sel.value; }
  }
  function renderRewards() {
    var rate = isFinite(Number(DATA.rewardsConfig.valuePerCoin)) ? Number(DATA.rewardsConfig.valuePerCoin) : Calc.DEFAULT_COIN_VALUE;
    rwCycleOptions();
    var h = el('div', 'kv');
    var rr = Calc.redemptionReconcile(DATA.records, DATA.redemptions);
    h.appendChild(kvRow('Total earned (all cycles)', fmtCoins(rr.totalEarned)));
    h.appendChild(kvRow('Transferred to Tata Neu', fmtCoins(rr.totalTransferred)));
    h.appendChild(kvRow('Redeemed (your ledger)', fmtCoins(rr.totalRedeemed)));
    h.appendChild(kvRow('Worth of earned at ₹' + fmtNum(rate) + '/coin', fmtMoney(Calc.rewardsValue(rr.totalEarned, rate))));
    $('rwSummary').replaceChildren(h);
    var rec = pickRecord(S.rwRec);
    $('rwCycle').replaceChildren(rec ? cycleRewardsTable(rec) : el('p', 'muted', 'Import a statement to see its category breakdown.'));
    $('rwReconcile').replaceChildren(redeemReconcileBox(rr));
    renderRedemptions();
  }
  function cycleRewardsTable(rec) {
    var body = el('div');
    var rb = Calc.rewardsByCategory(rec, DATA.ledger, prevRecordOf(rec));
    var cats = { upi: 'UPI', grocery: 'Grocery', base: 'Base', tata: 'Tata' };
    var has = Object.keys(rb.expected).length || Object.keys(rb.actual).length;
    if (!has) return el('p', 'muted', 'No coin-earning entries in this cycle.');
    var t = el('div', 'table');
    Object.keys(cats).forEach(function (k) {
      var exp = rb.expected[k] || 0, act = rb.actual[k] || 0;
      if (!exp && !act) return;
      var row = el('div', 'lrow');
      row.appendChild(el('span', 'l-date', cats[k]));
      var d = el('span', 'l-desc', 'expected +' + fmtCoins(exp));
      if (act !== exp) d.appendChild(el('span', 'meta', ' statement ' + (act ? '+' + fmtCoins(act) : '0')));
      row.appendChild(d);
      row.appendChild(el('span', 'l-cat', act === exp ? '✓' : (act > exp ? 'statement higher' : 'statement lower')));
      row.appendChild(el('span', 'l-amt', fmtCoins(exp)));
      t.appendChild(row);
    });
    Object.keys(rb.actual).forEach(function (k) {
      if (cats[k] != null) return;
      var row = el('div', 'lrow');
      row.appendChild(el('span', 'l-date', 'Other'));
      row.appendChild(el('span', 'l-desc', 'statement bonus program'));
      row.appendChild(el('span', 'l-cat', '—'));
      row.appendChild(el('span', 'l-amt', fmtCoins(rb.actual[k])));
      t.appendChild(row);
    });
    body.appendChild(t);
    body.appendChild(el('p', 'muted', 'Expected uses your ledger categories and the verified rates (UPI/Grocery/Base 1.5%, Tata 3.5%).'));
    return body;
  }
  function redeemReconcileBox(rr) {
    var box = el('div', 'kv');
    var gap = rr.netUnspent === 0 ? 'balanced ✓'
      : (rr.netUnspent > 0 ? 'more earned than redeemed/transferred — still in your balances' : 'more redeemed than earned — check older cycles');
    box.appendChild(kvRow('Earned − transferred − redeemed', fmtCoins(rr.netUnspent) + ' ' + gap));
    return box;
  }
  function addRedemption() {
    var date = $('rwDate').value, coins = parseFloat(String($('rwCoins').value).replace(/[, ]/g, ''));
    var value = parseFloat(String($('rwValue').value).replace(/[, ]/g, ''));
    var note = $('rwNote').value.trim();
    if (!date) { toast('Date required.', 'warn'); return; }
    if (!isFinite(coins) || coins <= 0) { toast('NeuCoins must be positive.', 'warn'); return; }
    DATA.redemptions.push({ id: 'r-' + Date.now().toString(36), date: date, coins: Math.round(coins), value: isFinite(value) ? Math.round(value * 100) / 100 : NaN, note: note });
    persist();
    $('rwCoins').value = ''; $('rwValue').value = ''; $('rwNote').value = '';
    renderRewards();
  }
  function delRedemption(id) {
    DATA.redemptions = DATA.redemptions.filter(function (x) { return x.id !== id; });
    persist();
    renderRewards();
  }
  function renderRedemptions() {
    var body = el('div');
    if (!DATA.redemptions.length) {
      body.appendChild(el('p', 'muted', 'No redemptions logged. Add each spend of NeuCoins (coins + what it was worth).'));
      $('rwList').replaceChildren(body);
      return;
    }
    var t = el('div', 'table');
    DATA.redemptions.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).forEach(function (x) {
      var row = el('div', 'lrow');
      row.appendChild(el('span', 'l-date', fmtDate(x.date)));
      var d = el('span', 'l-desc', x.note || 'redemption');
      if (isFinite(x.value)) d.appendChild(el('span', 'meta', ' worth ' + fmtMoney(x.value)));
      row.appendChild(d);
      row.appendChild(el('span', 'l-cat', fmtCoins(x.coins) + ' coins'));
      row.appendChild(el('span', 'l-amt', isFinite(x.value) ? fmtMoney(x.value) : '—'));
      var del = el('button', 'danger small', '✕');
      del.onclick = function () { delRedemption(x.id); };
      row.appendChild(del);
      t.appendChild(row);
    });
    body.appendChild(t);
    $('rwList').replaceChildren(body);
  }
  function coinConfig() {
    var box = el('div');
    box.appendChild(el('h2', '', 'Coin value'));
    box.appendChild(el('p', 'muted', 'Value of one NeuCoin in ₹, used for the "worth of rewards" estimates. Default: ₹0.25.'));
    var row = el('div', 'form');
    var inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.step = '0.01';
    inp.value = isFinite(Number(DATA.rewardsConfig.valuePerCoin)) ? DATA.rewardsConfig.valuePerCoin : Calc.DEFAULT_COIN_VALUE;
    row.appendChild(inp);
    var ok = el('button', 'primary', 'Save');
    ok.onclick = function () {
      var v = parseFloat(String(inp.value).replace(/[, ]/g, ''));
      DATA.rewardsConfig.valuePerCoin = isFinite(v) ? v : Calc.DEFAULT_COIN_VALUE;
      persist();
      closeModal();
      renderRewards();
    };
    row.appendChild(ok);
    box.appendChild(row);
    modal(box, true);
    setTimeout(function () { inp.focus(); }, 30);
  }

  /* ---------------- dues, payments & interest (merged into Home + Ledger) --- */
  function blForOptions() {
    var sel = $('blFor');
    sel.replaceChildren();
    if (!DATA.records.length) { sel.appendChild(el('option', '', 'No statements yet')); return; }
    DATA.records.slice().sort(function (a, b) { return (Calc.pdate(b.periodTo) || 0) - (Calc.pdate(a.periodTo) || 0); }).forEach(function (r) {
      var o = el('option', '', r.periodTo + (r.reconciled ? ' ✓' : ''));
      o.value = r.periodTo;
      sel.appendChild(o);
    });
    if (sel.selectedIndex === -1) sel.selectedIndex = 0;
  }
  function renderDueBoard() {
    var body = el('div');
    if (!DATA.records.length) {
      body.appendChild(el('p', 'muted', 'No statements yet — import and record one to see due dates.'));
      $('blDue').replaceChildren(body);
      return;
    }
    var recs = DATA.records.slice().sort(function (a, b) { return (Calc.pdate(b.periodTo) || 0) - (Calc.pdate(a.periodTo) || 0); });
    var t = el('div', 'table');
    recs.forEach(function (r) {
      var ds = Calc.dueStatus(r, DATA.payments);
      var row = el('div', 'lrow');
      row.appendChild(el('span', 'l-date', fmtDate(r.periodTo)));
      var d = el('span', 'l-desc', 'due ' + fmtDate(ds.dueDate) + ' · total ' + fmtMoney(r.total) + ' · min ' + fmtMoney(r.minimumDue));
      if (ds.daysLeft != null && ds.daysLeft >= 0) d.appendChild(el('span', 'meta', ds.daysLeft + ' day(s) left'));
      if (ds.overdue) d.appendChild(el('span', 'meta', 'overdue'));
      if (ds.kind !== 'none') d.appendChild(el('span', 'meta', 'paid ' + fmtMoney(ds.paid)));
      row.appendChild(d);
      row.appendChild(el('span', 'l-cat', ds.settled ? 'settled' : ds.kind));
      row.appendChild(el('span', 'l-amt', fmtMoney(ds.outstanding) + ' outstanding'));
      t.appendChild(row);
    });
    body.appendChild(t);
    $('blDue').replaceChildren(body);
  }
  function addPayment() {
    var date = $('blDate').value, forPeriod = $('blFor').value;
    var amount = parseFloat(String($('blAmt').value).replace(/[, ]/g, ''));
    var method = $('blMethod').value.trim();
    if (!date) { toast('Date required.', 'warn'); return; }
    if (!forPeriod || !DATA.records.some(function (r) { return r.periodTo === forPeriod; })) { toast('Pick a statement period.', 'warn'); return; }
    if (!isFinite(amount) || amount <= 0) { toast('Amount must be positive.', 'warn'); return; }
    DATA.payments.push({ id: 'p-' + Date.now().toString(36), date: date, amount: Math.round(amount * 100) / 100, forPeriod: forPeriod, method: method, note: '' });
    persist();
    $('blAmt').value = ''; $('blMethod').value = '';
    renderLedger();
    renderDueBoard();
  }
  function delPayment(id) {
    DATA.payments = DATA.payments.filter(function (p) { return p.id !== id; });
    persist();
    renderLedger();
    renderDueBoard();
  }
  function renderPayments() {
    blForOptions();
    var body = el('div');
    if (!DATA.payments.length) {
      body.appendChild(el('p', 'muted', 'No payments logged. Record what you actually paid the bank each cycle.'));
      $('blPayments').replaceChildren(body);
      return;
    }
    var t = el('div', 'table');
    DATA.payments.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).forEach(function (p) {
      var row = el('div', 'lrow');
      row.appendChild(el('span', 'l-date', fmtDate(p.date)));
      var d = el('span', 'l-desc', 'for ' + fmtDate(p.forPeriod));
      if (p.method) d.appendChild(el('span', 'meta', p.method));
      row.appendChild(d);
      row.appendChild(el('span', 'l-cat', 'payment'));
      row.appendChild(el('span', 'l-amt', fmtMoney(p.amount)));
      var del = el('button', 'danger small', '✕');
      del.onclick = function () { delPayment(p.id); };
      row.appendChild(del);
      t.appendChild(row);
    });
    body.appendChild(t);
    $('blPayments').replaceChildren(body);
  }
  function renderInterest() {
    var box = el('div');
    if (!DATA.records.length) { box.appendChild(el('p', 'muted', 'No statements yet.')); $('blInterest').replaceChildren(box); return; }
    var is = Calc.interestSummary(DATA.records);
    var charged = (is.perRecord || []).filter(function (r) { return r.finance > 0; });
    var kw = el('div', 'kv');
    kw.appendChild(kvRow('Cycles with interest', String(charged.length) + ' of ' + is.perRecord.length));
    kw.appendChild(kvRow('Total finance charges', fmtMoney(is.total)));
    kw.appendChild(kvRow('Largest cycle charge', charged.length
      ? fmtMoney(charged.reduce(function (a, b) { return (b.finance > a.finance) ? b : a; }).finance) : '—'));
    box.appendChild(kw);
    if (charged.length) {
      var t = el('div', 'table');
      charged.slice().sort(function (a, b) { return b.finance - a.finance; }).forEach(function (r) {
        var row = el('div', 'lrow');
        row.appendChild(el('span', 'l-date', fmtDate(r.periodTo)));
        row.appendChild(el('span', 'l-desc', 'finance charge'));
        row.appendChild(el('span', 'l-cat', 'interest'));
        row.appendChild(el('span', 'l-amt', fmtMoney(r.finance)));
        t.appendChild(row);
      });
      box.appendChild(t);
    } else {
      box.appendChild(el('p', 'muted', 'No finance charges yet — the revolver is being settled in full.'));
    }
    $('blInterest').replaceChildren(box);
  }

  /* ---------------- charts ---------------- */
  var chartMonthly = null, chartCats = null, chartEarned = null, chartBalance = null, chartUtil = null;
  /* the <h4> title sits inside the .card, a level above the canvas (.cv > canvas) */
  function setH4(canvas, show) {
    var card = canvas && canvas.closest('.card');
    if (!card) return;
    var h4 = card.querySelector('h4');
    if (h4) h4.style.display = show ? '' : 'none';
  }
  function destroyCharts() {
    if (chartMonthly) { chartMonthly.destroy(); chartMonthly = null; }
    if (chartCats) { chartCats.destroy(); chartCats = null; }
    if (chartEarned) { chartEarned.destroy(); chartEarned = null; }
    if (chartBalance) { chartBalance.destroy(); chartBalance = null; }
    if (chartUtil) { chartUtil.destroy(); chartUtil = null; }
  }
  function drawCharts() {
    if (!window.Chart) return;
    destroyCharts();
    /* monthly spend bar (from records) */
    var recs = DATA.records.slice().sort(function (a, b) { return a.periodTo < b.periodTo ? -1 : 1; }).filter(function (r) { return isFinite(r.purchases); });
    var cv1 = $('chartMonthly');
    var has1 = recs.length > 0;
    setH4(cv1, has1);
    if (has1) {
      chartMonthly = new Chart(cv1, {
        type: 'line',
        data: { labels: recs.map(function (r) { return shortMonth(r.periodTo); }), datasets: [{ label: 'Purchases', data: recs.map(function (r) { return r.purchases; }), borderColor: '#b8860b', backgroundColor: 'rgba(184,134,11,.15)', fill: true, tension: .25, pointRadius: 3 }] },
        options: { responsive: true, plugins: { legend: { display: false } } }
      });
    }
    /* category donut (from ledger) */
    var cats = {};
    DATA.ledger.forEach(function (e) {
      if (e.category === 'payment') return;
      cats[e.category] = (cats[e.category] || 0) + e.amount;
    });
    var cv2 = $('chartCats');
    var has2 = Object.keys(cats).length > 0;
    setH4(cv2, has2);
    if (has2) {
      var palette = { upi: '#2e86de', grocery: '#27ae60', base: '#8e8e8e', tata: '#e67e22', nocoins: '#bdc3c7', payment: '#6c757d' };
      var labels = Object.keys(cats).map(function (k) { return Calc.CATEGORIES[k].label; });
      chartCats = new Chart(cv2, {
        type: 'doughnut',
        data: { labels: labels, datasets: [{ data: Object.keys(cats).map(function (k) { return cats[k]; }), backgroundColor: Object.keys(cats).map(function (k) { return palette[k]; }) }] },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } }, maintainAspectRatio: false }
      });
    }

    /* rewards: earned bar + balance line (only when the tab is open) */
    var rwVis = $('rewards').style.display === 'block';
    if (rwVis) {
      var tl = Calc.rewardsTimeline(DATA.records);
      var cvE = $('chartEarned'), cvB = $('chartBalance');
      var hasE = tl.earned.length > 0;
      setH4(cvE, hasE);
      if (hasE) {
        chartEarned = new Chart(cvE, {
          type: 'bar',
          data: { labels: tl.earned.map(function (p) { return shortMonth(p.periodTo); }), datasets: [{ label: 'Earned', data: tl.earned.map(function (p) { return p.coins; }), backgroundColor: '#b8860b' }] },
          options: { responsive: true, plugins: { legend: { display: false } } }
        });
      }
      var hasB = tl.balance.length > 0;
      setH4(cvB, hasB);
      if (hasB) {
        chartBalance = new Chart(cvB, {
          type: 'line',
          data: { labels: tl.balance.map(function (p) { return shortMonth(p.periodTo); }), datasets: [{ label: 'Balance', data: tl.balance.map(function (p) { return p.coins; }), borderColor: '#b8860b', backgroundColor: 'rgba(184,134,11,.15)', fill: true, tension: .25, pointRadius: 3 }] },
          options: { responsive: true, plugins: { legend: { display: false } } }
        });
      }
    }

    /* utilization line (home chart, from records) */
    var utRecs = DATA.records.filter(function (r) { return Calc.utilizationOf(r) != null; }).sort(function (a, b) { return a.periodTo < b.periodTo ? -1 : 1; });
    var cvU = $('chartUtil');
    var hasU = utRecs.length > 0;
    setH4(cvU, hasU);
    if (hasU) {
      chartUtil = new Chart(cvU, {
        type: 'line',
        data: { labels: utRecs.map(function (r) { return shortMonth(r.periodTo); }), datasets: [{ label: 'Utilization %', data: utRecs.map(function (r) { return Calc.utilizationOf(r); }), borderColor: '#27ae60', backgroundColor: 'rgba(39,174,96,.15)', fill: true, tension: .25, pointRadius: 3 }] },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { suggestedMax: 100 } } }
      });
    }
  }
  function shortMonth(periodTo) {
    var m = String(periodTo || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) return periodTo || '—';
    var names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return names[+m[2] - 1] + ' ' + m[3].slice(2);
  }

  /* ---------------- history ---------------- */
  function ledgerCoins() {
    var t = 0;
    DATA.ledger.forEach(function (e) { t += Calc.predictedCoins(e).coins; });
    return t;
  }
  function renderAll() {
    renderLanding();
    renderLedger();
    if (window.Chart) requestAnimationFrame(drawCharts); else drawCharts();
    renderDueBoard();
    renderInterest();
    if ($('rewards').style.display === 'block') renderRewards();
    if (S.recId && $('rcSel') && $('reconcile').style.display === 'block') renderReconcile();
  }
  function renderLanding() {
    var h = el('div');
    var kw = el('div', 'kv');
    var k = DATA.records.length ? DATA.records[DATA.records.length - 1] : null;
    kw.appendChild(kvRow('Statements verified', String(DATA.records.length)));
    kw.appendChild(kvRow('Ledger entries', String(DATA.ledger.length)));
    kw.appendChild(kvRow('Latest period', fmtDate(k ? k.periodTo : '—')));
    kw.appendChild(kvRow('Latest total', k ? fmtMoney(k.total) : '—'));
    kw.appendChild(kvRow('Predicted ledger coins', fmtCoins(ledgerCoins())));
    kw.appendChild(kvRow('Profile card', (DATA.card.no ? DATA.card.no.slice(0, 4) + ' … ' + DATA.card.no.slice(-4) : 'not set')));
    h.appendChild(kw);

    if (DATA.records.length) {
      $('heroImport').textContent = 'Import another statement';
      h.appendChild(el('h4', '', 'History'));
      var t = el('div', 'table');
      DATA.records.slice().sort(function (a, b) { return (Calc.pdate(b.periodTo) || 0) - (Calc.pdate(a.periodTo) || 0); }).forEach(function (r) {
        var row = el('div', 'lrow');
        row.appendChild(el('span', 'l-date', fmtDate(r.periodTo)));
        var dsc = el('span', 'l-desc', 'total ' + fmtMoney(r.total) + ' · purchased ' + fmtMoney(r.purchases) + ' · coins ' + fmtCoins(r.closingNeuCoins));
        if (r.reconciled) dsc.appendChild(el('span', 'tick', ' ✓ reconciled'));
        if (r.accepted && r.accepted.length) dsc.appendChild(el('span', 'meta', r.accepted.length + ' exception(s)'));
        row.appendChild(dsc);
        if (!r.reconciled) {
          var btn = el('button', 'small', 'Reconcile');
          btn.onclick = function () { openReconcile(r); };
          row.appendChild(btn);
          var res = Calc.reconcile(r, DATA.ledger, prevRecordOf(r));
          if (res.stmtOnly.length) {
            var addBtn = el('button', 'small', 'Add ' + res.stmtOnly.length + ' to ledger');
            addBtn.title = 'Book every statement-only row into the ledger from here — no need to open Reconcile.';
            addBtn.onclick = function () { bookStmtOnly(r); };
            row.appendChild(addBtn);
          }
        }
        var del = el('button', 'danger small', '✕');
        del.title = 'Remove this record';
        del.onclick = function () { removeRecord(r); };
        row.appendChild(del);
        t.appendChild(row);
      });
      h.appendChild(t);
    } else {
      $('heroImport').textContent = 'Import your first statement';
      h.appendChild(el('p', 'muted', 'No statements recorded. Import your HDFC Neu statement PDF below to start verifying.'));
    }
    $('landingStats').replaceChildren(h);
    $('importCounter').textContent = DATA.records.length ? 'Stored: ' + DATA.records.length + ' · last ' + fmtDate(DATA.records[DATA.records.length - 1].periodTo) : 'No statements stored yet.';
  }
  function removeRecord(r) {
    var box = el('div');
    box.appendChild(el('h2', '', 'Remove statement?'));
    box.appendChild(el('p', '', 'Delete the record for ' + r.periodTo + ' (' + fmtMoney(r.total) + '). Matched ledger entries will keep their ✓.'));
    var ok = el('button', 'danger', 'Remove');
    ok.onclick = function () {
      DATA.records = DATA.records.filter(function (x) { return x.id !== r.id; });
      persist();
      closeModal();
      renderAll();
      toast('Record removed.', 'ok');
    };
    box.appendChild(el('div', 'form'));
    box.lastChild.appendChild(ok);
    modal(box, true);
  }

  /* ---------------- bundle ---------------- */
  function bundleText() {
    return '/* HDFC Tata Neu Credit Card Tracker data bundle v' + (DATA.version || 1) + ' — regenerate via Save bundle. */\nwindow.DATA = ' +
      JSON.stringify(DATA, null, 1) + ';\n';
  }
  function saveBundle() {
    download('bundle.js', bundleText(), 'text/javascript');
    toast('bundle.js downloaded. Replace data/bundle.js to make this folder portable.', 'ok');
  }
  function loadBundleFile(file) {
    file.text().then(function (t) {
      var s = t.replace(/^\s*window\.DATA\s*=\s*/, '');
      s = s.replace(/\s*;\s*$/, '');
      var d = JSON.parse(s);
      if (!d || (!Array.isArray(d.records) && !Array.isArray(d.ledger))) throw new Error('not a bundle');
      var migrated = Calc.migrateBundle(d);
      if (migrated.incompatible) { toast('Bundle is from a newer app version — update first.', 'bad'); return; }
      DATA = migrated;
      window.DATA = migrated;
      persist();
      renderAll();
      toast('Bundle loaded: ' + migrated.records.length + ' statements, ' + migrated.ledger.length + ' ledger entries.', 'ok');
    }, function (e) { toast('Could not read bundle: ' + e.message, 'bad'); }).catch(function (e) { toast('Invalid bundle file: ' + e.message, 'bad'); });
  }

  /* ---------------- wiring ---------------- */
  function showView(id) { show(id); renderAll(); }

  function showVersion() {
    var badge = $('verBadge');
    if (!badge) return;
    var v = 'v' + APP_VERSION;
    badge.hidden = false;
    badge.textContent = v;
    badge.title = 'Build ' + v;
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
    try {
      var ch = new MessageChannel();
      ch.port1.onmessage = function (ev) {
        var swv = ev.data && ev.data.version;
        if (swv) badge.title = 'Build ' + v + ' · SW cache ' + swv;
      };
      navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
    } catch (e) {}
  }

  function init() {
    loadData();
    showVersion();
    $('importFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) importFile(f);
      e.target.value = '';
    });
    $('homeGo').addEventListener('click', function () { showView('landing'); });
    $('ledgerGo').addEventListener('click', function () { showView('ledger'); });
    $('rewardsGo').addEventListener('click', function () { showView('rewards'); });
    $('importGo').addEventListener('click', function () { showView('landing'); $('importFile').click(); });
    $('addBtn').addEventListener('click', addEntry);
    renderCategoryOptions($('leCat'));
    $('leCat').addEventListener('change', function () { $('leHint').textContent = hintFor($('leCat').value); });
    $('leDate').value = todayStr();
    $('leHint').textContent = hintFor('upi');
    $('rcSel').addEventListener('change', renderReconcile);
    $('commitBtn').addEventListener('click', commitStatement);
    $('discardBtn').addEventListener('click', function () { showView('landing'); toast('Discarded.', 'warn'); });
    $('rwSel').addEventListener('change', function () { S.rwRec = $('rwSel').value; renderRewards(); });
    $('rwAddBtn').addEventListener('click', addRedemption);
    $('rwConfigBtn').addEventListener('click', coinConfig);
    $('rwDate').value = todayStr();
    $('blAddBtn').addEventListener('click', addPayment);
    $('blDate').value = todayStr();
    $('saveBundleBtn').addEventListener('click', saveBundle);
    $('openBundleInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) loadBundleFile(f);
      e.target.value = '';
    });
    $('openBundleBtn').addEventListener('click', function () { $('openBundleInput').click(); });
    renderAll();
  }
  document.addEventListener('DOMContentLoaded', init);

  window.App = App;
})();