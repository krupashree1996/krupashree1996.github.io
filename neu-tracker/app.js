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
  var APP_VERSION = 8;

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
    try { a.href = URL.createObjectURL(b); } catch (e) { a.href = 'data:,'; }
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function download(name, text, mime) { saveFile(name, text, mime || 'application/octet-stream'); }

  function show(id) {
    ['landing', 'verify', 'ledger', 'reconcile'].forEach(function (x) {
      var n = $(x);
      if (!n) return;
      n.style.display = (x === id ? 'block' : 'none');
    });
  }

  /* ---------------- state ---------------- */
  var DATA = null;      // migrated copy of window.DATA / localStorage (holds cards[])
  var C = null;         // the active card profile (DATA.cards[activeCardId])
  var S = { st: null, checks: null, decisions: {}, curRecord: null, recId: null, chartB: null, chartC: null, autoScheduled: false, committed: false, autoTimer: null, histCount: 3, dueCount: 3, editing: null };
  var importing = false;

  function activeCard() {
    var id = DATA.activeCardId;
    var c = DATA.cards.filter(function (x) { return x.id === id; })[0];
    return c || DATA.cards[0];
  }
  function isNeu() { return C && C.type === 'neu'; }

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
    C = activeCard();
    normalizeLedgerDates();
  }
  /* Session-only: lives in sessionStorage — survives reloads of this tab,
   * wiped when the browser (or tab) closes. Never in localStorage. */
  function getPw() { try { return sessionStorage.getItem(PW_KEY) || ''; } catch (e) { return ''; } }
  function setPw(p) { try { if (p) sessionStorage.setItem(PW_KEY, p); else sessionStorage.removeItem(PW_KEY); } catch (e) { } }

  /* ---------------- import / parse ---------------- */
  function readPdf(ab, pw) {
    /* pdf.js transfers the buffer to its worker (detaching it), so every
     * attempt needs a fresh copy — otherwise retrying after the password
     * prompt reuses an empty buffer and silently fails. */
    var task = pdfjsLib.getDocument({ data: ab.slice(0), password: pw || undefined, isEvalSupported: false });
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
  }
  function deleteCard() {
    if (!C || DATA.cards.length <= 1) { toast('Keep at least one card profile.', 'warn'); return; }
    var c = C;
    var box = el('div');
    box.appendChild(el('h2', '', 'Delete card'));
    var msg = el('p', 'muted', 'This permanently removes ');
    msg.appendChild(el('b', '', c.name));
    msg.appendChild(el('span', '', ' and its ' + c.records.length + ' statement(s) and ' +
      c.ledger.length + ' ledger entr' + (c.ledger.length === 1 ? 'y' : 'ies') + '. This cannot be undone.'));
    box.appendChild(msg);
    var row = el('div', 'form');
    var del = el('button', 'danger', 'Delete');
    del.onclick = function () {
      var idx = DATA.cards.indexOf(c);
      DATA.cards.splice(idx, 1);
      /* if the deleted card was active, fall back to the first remaining one */
      if (DATA.activeCardId === c.id) DATA.activeCardId = DATA.cards[0].id;
      C = activeCard();
      S.editing = null;
      persist();
      closeModal();
      renderCardSwitcher();
      renderAll();
      toast('Deleted ' + c.name, 'ok');
    };
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.onclick = closeModal;
    row.appendChild(del); row.appendChild(cancel);
    box.appendChild(row);
    modal(box, true);
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
      function askAndRetry() {
        askPassword(function (pw) {
          attempt(pw).catch(function (e2) {
            if (e2 && e2.name === 'PasswordException' && e2.code === 2) {
              toast('Incorrect password — try again.', 'bad');
              askAndRetry();
              return;
            }
            toast((e2 && e2.message) || 'Could not open this PDF.', 'bad');
          });
        });
      }
      attempt(getPw()).catch(function (e) {
        if (e && e.name === 'PasswordException') {
          if (e.code === 2) toast('Incorrect password — try again.', 'bad');
          askAndRetry();
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
    /* Unbilled (approx) = the part of current outstanding not yet on this bill.
     * creditLimit − availLimit is total outstanding (billed + unbilled); subtract
     * this bill's total due to approximate what's accrued but not yet billed. */
    if (isFinite(st.creditLimit) && isFinite(st.availLimit) && isFinite(st.total) && st.creditLimit > 0) {
      var unbilled = Math.max(Math.round((st.creditLimit - st.availLimit - st.total) * 100) / 100, 0);
      box.appendChild(kvRow('Unbilled (approx)', fmtMoney(unbilled)));
    }
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
    var sorted = C.records.filter(function (r) { return r !== rec; }).sort(function (a, b) {
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
    var dup = C.records.filter(function (r) { return r.periodTo === st.periodTo; })[0];
    S.curRecord = dup || null;
    if (dup) toast('A record for this period already exists — verifying again will replace it.', 'warn');
    var v = Calc.verifyStatement(st, { prevRecord: prevRecordOf(dup || { periodTo: st.periodTo }) || (C.records.length ? C.records[C.records.length - 1] : null), cardNo: C.card.no });
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
    var id = 's-' + st.periodTo.replace(/\//g, '');
    return {
      id: id,
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
      /* the estimate that was on Home BEFORE this statement was imported —
       * lets the row compare it against the actuals right after import.
       * Computed over records EXCLUDING this one (stable on re-import too). */
      estimated: (function () { var e = Calc.estimatedDue(C.records.filter(function (r) { return r.id !== id; }), C.ledger); e.base = e.base || st.periodTo; return e; })(),
      status: 'verified',
      /* re-importing a recorded period must not wipe its reconciled flag or
       * previously noted exceptions */
      reconciled: S.curRecord && S.curRecord.reconciled ? S.curRecord.reconciled : ''
    };
  }
  function commitStatement(auto) {
    S.committed = true;
    var rec = buildRecord();
    var i = C.records.findIndex(function (r) { return r.id === rec.id; });
    if (i >= 0) C.records[i] = rec; else C.records.push(rec);
    C.records.sort(function (a, b) { return (Calc.pdate(a.periodTo) || 0) - (Calc.pdate(b.periodTo) || 0); });
    /* importing this statement proves the previous bill's dues were paid →
     * auto-record that payment so the old bill shows 'settled'. */
    if (Calc.autoSettlePrior(C.records, C.ledger, rec) > 0) {
      toast('Previous bill marked paid (auto).', 'ok');
    }
    persist();
    toast(auto ? 'All checks passed — statement recorded automatically for ' + (rec.periodTo || rec.statementDate) + '.' : 'Statement recorded for ' + (rec.periodTo || rec.statementDate) + '.', 'ok');
    show('landing');
    renderAll();
    /* auto-reconcile when the ledger fully matches the bill (nothing unmatched on
     * either side) → home. Otherwise the user must close the cycle out: stay on
     * the reconcile page until they click "Mark as reconciled (anyway)". */
    var res = Calc.reconcile(rec, C.ledger, prevRecordOf(rec));
    if (!rec.reconciled && res.matchedCount > 0 && !res.bookOnlyCount && !res.stmtOnlyCount) {
      markReconciled(rec, res);
      return;
    }
    setTimeout(function () { openReconcile(rec); }, 60);
  }

  /* ---------------- ledger ---------------- */
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return String(n).length === 1 ? '0' + n : String(n); }
  /* native <input type=date> works in yyyy-mm-dd; storage keeps dd/mm/yyyy.
   * Both directions tolerate non-zero-padded day/month (e.g. 5/10/2026). */
  function toISO(d) {
    var m = String(d || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? m[3] + '-' + pad(m[2]) + '-' + pad(m[1]) : '';
  }
  function fromISO(s) {
    var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? pad(m[3]) + '/' + pad(m[2]) + '/' + m[1] : '';
  }
  /* group keys below use date.slice(6,10)/slice(3,5) — needs fixed-width
   * dd/mm/yyyy; normalize every ledger date on load and after edits */
  function normalizeLedgerDates() {
    C.ledger.forEach(function (e) {
      var iso = toISO(e.date);
      if (iso && iso !== e.date) e.date = fromISO(iso);
    });
  }

  function renderCategoryOptions(sel) {
    sel.replaceChildren();
    /* coin-earning categories (upi/grocery/base/tata) use Tata-Neu rates —
     * a generic card (Axis Scapia) earns no coins, so only NoCoins + Payment
     * apply to it. */
    var onlyNoCoin = !isNeu();
    Object.keys(Calc.CATEGORIES).forEach(function (k) {
      if (onlyNoCoin && Calc.CATEGORIES[k].rate > 0) return;
      var c = Calc.CATEGORIES[k];
      var o = el('option', '', c.label + ' · ' + c.note);
      o.value = k;
      sel.appendChild(o);
    });
  }
  /* (re)build the category dropdown for the active card and pick its default:
   * Neu → UPI (the usual case), generic → NoCoins. */
  function rebuildCategoryOptions() {
    var sel = $('leCat');
    renderCategoryOptions(sel);
    sel.value = isNeu() ? 'upi' : 'nocoins';
    $('leHint').textContent = hintFor(sel.value);
  }
  function hintFor(cat) {
    var c = Calc.CATEGORIES[cat];
    return c ? c.label + ': ' + c.note + (c.rate ? ' → ' + Math.round(c.rate * 100) + '%' : '') : '';
  }
  function addEntry() {
    var date = fromISO($('leDate').value), desc = $('leDesc').value.trim(), cat = $('leCat').value;
    var amount = parseFloat(String($('leAmt').value).replace(/[, ]/g, ''));
    if (!date) { toast('Date required.', 'warn'); return; }
    if (!desc) { toast('Description required.', 'warn'); return; }
    if (!isFinite(amount) || amount <= 0) { toast('Amount must be a positive number.', 'warn'); return; }
    var editing = S.editing;
    var entry = editing
      ? C.ledger.filter(function (e) { return e.id === editing; })[0]
      : { id: 'e-' + Date.now().toString(36), reconciled: '' };
    entry.date = date; entry.desc = desc; entry.category = cat;
    entry.amount = Math.round(amount * 100) / 100;
    if (cat === 'payment') {
      /* a linked period forces the repayment onto that bill; if left blank it
       * applies by payment date (after a bill closes, before the next closes) */
      entry.forPeriod = $('lePeriod').value;
    } else {
      delete entry.forPeriod;
    }
    if (!editing) C.ledger.push(entry);
    normalizeLedgerDates();
    S.editing = null;
    $('addBtn').textContent = 'Add entry';
    $('editCancelBtn').hidden = true;
    persist();
    renderLedger();
    renderLanding(); // keep the home "Unbilled" total live as entries are added/edited
    $('leDesc').value = '';
    $('leAmt').value = '';
    $('leDate').value = todayISO();
  }
  function editEntry(id) {
    var e = C.ledger.filter(function (x) { return x.id === id; })[0];
    if (!e) return;
    S.editing = id;
    $('leDate').value = toISO(e.date);
    $('leDesc').value = e.desc;
    $('leCat').value = e.category;
    $('leHint').textContent = hintFor(e.category);
    $('lePeriod').value = e.category === 'payment' ? (e.forPeriod || '') : '';
    $('lePeriodWrap').style.display = e.category === 'payment' ? '' : 'none';
    $('leAmt').value = e.amount;
    $('addBtn').textContent = 'Save changes';
    $('editCancelBtn').hidden = false;
    showView('ledger');
    $('leDate').focus();
    $('leDate').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function cancelEdit() {
    S.editing = null;
    $('addBtn').textContent = 'Add entry';
    $('editCancelBtn').hidden = true;
    $('leDesc').value = '';
    $('leAmt').value = '';
    $('leDate').value = todayISO();
    renderLedger();
  }
  function delEntry(id) {
    C.ledger = C.ledger.filter(function (e) { return e.id !== id; });
    if (S.editing === id) cancelEdit();
    persist();
    renderLedger();
    renderLanding();
  }
  function ledgerEntryRow(e) {
    var row = el('div', 'lrow');
    var guess = e.guess ? (Calc.CATEGORIES[e.guess] ? Calc.CATEGORIES[e.guess].label : '') : '';
    row.appendChild(el('span', 'l-date', fmtDate(e.date)));
    var d = el('span', 'l-desc', e.desc);
    if (guess && guess !== Calc.CATEGORIES[e.category].label) d.appendChild(el('span', 'meta', ' guessed ' + guess));
    if (e.category === 'payment' && e.forPeriod) d.appendChild(el('span', 'meta', ' · for ' + fmtDate(e.forPeriod)));
    row.appendChild(d);
    var p = Calc.predictedCoins(e);
    var cat = el('span', 'l-cat', Calc.CATEGORIES[e.category].label + (p.coins ? ' +' + fmtCoins(p.coins) : ''));
    var cs = Calc.coinSplit(e);
    if (cs) {
      var sub = el('span', 'coin-split', cs.basePct + '% ' + cs.srcBase + ' ' + fmtCoins(cs.base) + ' · ' + cs.bonusPct + '% ' + cs.srcBonus + ' ' + fmtCoins(cs.bonus) + (cs.nextCycle ? ' (next cycle)' : ''));
      sub.title = Calc.CATEGORIES[e.category].note;
      cat.appendChild(sub);
    }
    row.appendChild(cat);
    var amt = el('span', 'l-amt', fmtMoney(e.category === 'payment' ? -e.amount : e.amount));
    if (e.reconciled) amt.appendChild(el('span', 'tick', ' ✓ reconciled'));
    row.appendChild(amt);
    var edit = el('button', 'small', 'Edit');
    edit.title = 'Edit this entry';
    edit.onclick = function () { editEntry(e.id); };
    row.appendChild(edit);
    var del = el('button', 'danger small', '✕');
    del.title = 'Delete this entry';
    del.onclick = function () { delEntry(e.id); };
    row.appendChild(del);
    return row;
  }
  function renderLedger() {
    normalizeLedgerDates();
    var cats = {};
    var groups = {};
    var byCat = { upi: 0, grocery: 0, base: 0, tata: 0, nocoins: 0, payment: 0 };
    C.ledger.forEach(function (e) {
      /* dates are dd/mm/yyyy → group key "yyyy-mm" (e.g. "2025-12"); string
       * sort on that key is chronological across year boundaries too.
       * Entries within a month are re-sorted below by real timestamp. */
        var giso = toISO(e.date); // fixed yyyy-mm-dd, even if stored as 5/10/2026
        var mk = giso ? giso.slice(0, 7) : '????-??'; // "yyyy-mm"
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
        var h = el('div', 'lg-h', (mnames[+m.slice(5) - 1] ? mnames[+m.slice(5) - 1] + ' ' + m.slice(0, 4) : 'Unknown date'));
      $('ledgerList').appendChild(h);
      groups[m].slice().sort(function (a, b) { return (Calc.pdate(b.date) || 0) - (Calc.pdate(a.date) || 0); }).forEach(function (e) {
        $('ledgerList').appendChild(ledgerEntryRow(e));
      });
    });
    if (!months.length) $('ledgerList').appendChild(el('p', 'muted', 'No entries yet. Add your card spends here and reconcile each statement after importing it.'));
    lePeriodOptions();
  }

  /* ---------------- reconcile ---------------- */
  function renderRecordOptions(sel) {
    sel.replaceChildren();
    if (!C.records.length) {
      var o = el('option', '', 'No statements imported yet');
      sel.appendChild(o);
      return;
    }
    C.records.slice().sort(function (a, b) { return (Calc.pdate(b.periodTo) || 0) - (Calc.pdate(a.periodTo) || 0); }).forEach(function (r) {
      var o = el('option', '', r.periodTo + (r.reconciled ? ' ✓ reconciled' : '') + ' · ' + fmtMoney(r.total));
      o.value = r.periodTo;
      sel.appendChild(o);
    });
  }
  function pickRecord(periodTo) {
    return C.records.filter(function (r) { return r.periodTo === periodTo; })[0] || null;
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
    /* count-based dedupe: a statement can carry N identical rows (same
     * day + amount). Book exactly the rows reconcile still sees as missing —
     * matched entries must not suppress a genuinely missing duplicate. */
    var rows = Calc.stmtRowsToBook(rec, C.ledger, prevRecordOf(rec));
    var added = 0;
    rows.forEach(function (tx) {
      C.ledger.push({
        id: 'e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        date: tx.date, desc: tx.desc,
        category: Calc.guessCategory(tx),
        amount: Math.round(tx.amount * 100) / 100, reconciled: '',
        /* which statement this row came from — lets the NEXT statement's
         * reconcile ignore it as "not on statement" (its date may fall in that
         * window without belonging to it) */
        sourcePeriod: rec.periodTo
      });
      added++;
    });
    persist();
    renderLedger();
    /* re-run reconcile and follow the usual path: if the bill now fully
     * matches, auto-reconcile and return home; else refresh the current view. */
    var res2 = Calc.reconcile(rec, C.ledger, prevRecordOf(rec));
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
    var res = Calc.reconcile(rec, C.ledger, prevRecordOf(rec));
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
        var dcat = el('span', 'l-cat', Calc.CATEGORIES[e.category].label + (Calc.predictedCoins(e).coins ? ' +' + fmtCoins(Calc.predictedCoins(e).coins) : ''));
        var dcs = Calc.coinSplit(e);
        if (dcs) {
          var dsub = el('span', 'coin-split', dcs.basePct + '% ' + dcs.srcBase + ' ' + fmtCoins(dcs.base) + ' · ' + dcs.bonusPct + '% ' + dcs.srcBonus + ' ' + fmtCoins(dcs.bonus) + (dcs.nextCycle ? ' (next cycle)' : ''));
          dcat.appendChild(dsub);
        }
        r.appendChild(dcat);
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

  /* ---------------- dues & interest (due board + interest on Home) ----------- */
  /* "For period" options for Payment ledger entries: pick the bill this
   * repayment clears, or leave it on Auto to apply by payment date. Rebuilt
   * whenever records change. */
  function lePeriodOptions() {
    var sel = $('lePeriod');
    if (!sel) return;
    var cur = sel.value;
    sel.replaceChildren();
    sel.appendChild(el('option', '', 'Auto — apply by payment date'));
    C.records.slice().sort(function (a, b) { return (Calc.pdate(b.periodTo) || 0) - (Calc.pdate(a.periodTo) || 0); }).forEach(function (r) {
      var o = el('option', '', r.periodTo + (r.reconciled ? ' ✓' : ''));
      o.value = r.periodTo;
      sel.appendChild(o);
    });
    sel.value = cur || '';
  }
  function renderDueBoard() {
    var body = el('div');
    if (!C.records.length) {
      body.appendChild(el('p', 'muted', 'No statements yet — import and record one to see due dates.'));
      $('blDue').replaceChildren(body);
      return;
    }
    var recs = C.records.slice().sort(function (a, b) { return (Calc.pdate(b.periodTo) || 0) - (Calc.pdate(a.periodTo) || 0); });
    var t = el('div', 'table');
    recs.slice(0, S.dueCount).forEach(function (r) {
      var ds = Calc.dueStatus(r, C.ledger, C.records);
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
    if (recs.length > S.dueCount) {
      var more = el('button', 'small', 'Show ' + Math.min(3, recs.length - S.dueCount) + ' more');
      more.onclick = function () { S.dueCount += 3; renderDueBoard(); };
      body.appendChild(more);
    }
    $('blDue').replaceChildren(body);
  }
  /* Annual fee waiver: spend the configured target (default ₹3L) in the
   * [Jan 19 → next Jan 18] window. Spend = statement purchases with periodTo
   * in the window. */
  function renderFeeWaiver() {
    if (!isNeu()) { $('blFee').replaceChildren(el('p', 'muted', 'Annual-fee waiver tracking is Neu-specific.')); return; }
    var cfg = C.feeConfig || {};
    var w = Calc.waiverStatus(C.records, new Date(), cfg);
    var box = el('div');
    var kw = el('div', 'kv');
    /* window is [Jan 19, y) → the last included day is Jan 18, y+1; show both
     * years (same month-day otherwise reads "Jan 19 → Jan 19") */
    var lastDay = new Date(+w.windowTo - 86400000);
    var fdate = function (d) { var n = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; return n[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); };
    kw.appendChild(kvRow('Window', fdate(w.windowFrom) + ' → ' + fdate(lastDay)));
    kw.appendChild(kvRow('Target spend', fmtMoney(w.target)));
    kw.appendChild(kvRow('Spent in window', fmtMoney(w.spent)));
    kw.appendChild(kvRow(w.waived ? 'Status' : 'Still needed', w.waived ? 'fees waived ✓' : fmtMoney(w.remaining) + ' · ' + w.daysLeft + ' day(s) left'));
    box.appendChild(kw);
    var btn = el('button', 'ghost', 'Waiver target…');
    btn.title = 'Change the waiver spend target / window start';
    btn.onclick = function () { feeConfig(); };
    box.appendChild(el('div', 'form'));
    box.lastChild.appendChild(btn);
    $('blFee').replaceChildren(box);
  }
  function feeConfig() {
    var box = el('div');
    box.appendChild(el('h2', '', 'Fee waiver'));
    box.appendChild(el('p', 'muted', 'Spend at least this much between Jan 19 and Jan 18 (next year) and the annual fee is waived. Default ₹3,00,000.'));
    var row = el('div', 'form');
    var inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.step = '1000';
    inp.value = isFinite(Number(C.feeConfig.target)) ? C.feeConfig.target : 300000;
    row.appendChild(inp);
    var ok = el('button', 'primary', 'Save');
    ok.onclick = function () {
      var v = parseFloat(String(inp.value).replace(/[, ]/g, ''));
      C.feeConfig.target = isFinite(v) && v > 0 ? v : 300000;
      persist();
      closeModal();
      renderFeeWaiver();
    };
    row.appendChild(ok);
    box.appendChild(row);
    modal(box, true);
    setTimeout(function () { inp.focus(); }, 30);
  }
  function cardProfile() {
    var box = el('div');
    box.appendChild(el('h2', '', 'Profile card'));
    box.appendChild(el('p', 'muted', 'When you import a statement, its printed card number is checked against this. If it matches, the import is accepted; if it differs, the import is flagged so you can double-check.'));
    box.appendChild(el('p', 'muted', 'Type the last 4 digits (e.g. 8311) or the full 16-digit number — either works. It is stored on this device only and never sent anywhere.'));
    var row = el('div', 'form');
    var inp = el('input'); inp.type = 'text'; inp.inputMode = 'numeric'; inp.autocomplete = 'off';
    inp.placeholder = 'e.g. 8311 (last 4) or all 16 digits'; inp.value = C.card.no || '';
    row.appendChild(inp);
    var ok = el('button', 'primary', 'Save');
    ok.onclick = function () {
      var v = String(inp.value || '').replace(/\D/g, '');
      C.card.no = v;
      persist();
      closeModal();
      renderLanding();
      toast(v ? 'Profile card set.' : 'Profile card cleared.', 'ok');
    };
    row.appendChild(ok);
    var clr = el('button', 'ghost', 'Clear');
    clr.onclick = function () {
      C.card.no = '';
      persist();
      closeModal();
      renderLanding();
      toast('Profile card cleared.', 'ok');
    };
    row.appendChild(clr);
    box.appendChild(row);
    modal(box, true);
    setTimeout(function () { inp.focus(); }, 30);
  }
  function renderInterest() {
    var box = el('div');
    if (!C.records.length) { box.appendChild(el('p', 'muted', 'No statements yet.')); $('blInterest').replaceChildren(box); return; }
    var is = Calc.interestSummary(C.records);
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
  var chartMonthly = null, chartCats = null, chartUtil = null;
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
    if (chartUtil) { chartUtil.destroy(); chartUtil = null; }
  }
  function drawCharts() {
    if (!window.Chart) return;
    destroyCharts();
    /* monthly spend bar (from records) */
    /* last 12 cycles only, sorted by real date (string sort on dd/mm/yyyy
     * interleaves years: 01/2025, 01/2026, 02/2025, …) */
    var recs = C.records.slice().sort(function (a, b) { return (Calc.pdate(a.periodTo) || 0) - (Calc.pdate(b.periodTo) || 0); }).filter(function (r) { return isFinite(r.purchases); }).slice(-12);
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
    C.ledger.forEach(function (e) {
      if (e.category === 'payment') return;
      cats[e.category] = (cats[e.category] || 0) + e.amount;
    });
    var cv2 = $('chartCats');
    var has2 = Object.keys(cats).length > 0;
    setH4(cv2, has2);
    if (has2) {
      var palette = { upi: '#2e86de', grocery: '#27ae60', base: '#8e8e8e', tata: '#e67e22', tatagroc: '#16a085', nocoins: '#bdc3c7', payment: '#6c757d' };
      var labels = Object.keys(cats).map(function (k) { return Calc.CATEGORIES[k].label; });
      chartCats = new Chart(cv2, {
        type: 'doughnut',
        data: { labels: labels, datasets: [{ data: Object.keys(cats).map(function (k) { return cats[k]; }), backgroundColor: Object.keys(cats).map(function (k) { return palette[k]; }) }] },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } }, maintainAspectRatio: false }
      });
    }

    /* utilization line (home chart, from records) */
    var utRecs = C.records.filter(function (r) { return Calc.utilizationOf(r) != null; }).sort(function (a, b) { return (Calc.pdate(a.periodTo) || 0) - (Calc.pdate(b.periodTo) || 0); }).slice(-12);
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
  function renderAll() {
    renderLanding();
    renderLedger();
    if (window.Chart) requestAnimationFrame(drawCharts); else drawCharts();
    renderDueBoard();
    renderFeeWaiver();
    renderInterest();
    if (S.recId && $('rcSel') && $('reconcile').style.display === 'block') renderReconcile();
  }
  function renderLanding() {
    var h = el('div');
    var k = null;
    C.records.forEach(function (r) {
      var t = Calc.pdate(r.periodTo) || 0;
      if (!k || t > (Calc.pdate(k.periodTo) || 0)) k = r;
    });
    var ds = k ? Calc.dueStatus(k, C.ledger, C.records) : null;

    /* Current bill = the latest imported statement, kept separate from the
     * next-bill estimate so the printed bill amount never looks like a moving
     * forecast. Payments reduce Paid/Outstanding here first. */
    h.appendChild(el('h4', '', 'Current bill'));
    var kw = el('div', 'kv');
    if (k) {
      var dueText = fmtDate(k.dueDate);
      if (ds.daysLeft != null) dueText += ds.daysLeft >= 0 ? ' · ' + ds.daysLeft + ' day(s) left' : ' · overdue';
      var status = ds.kind === 'full' ? 'settled ✓'
        : ds.kind === 'minimum' ? 'minimum paid'
        : ds.kind === 'partial' ? 'part paid'
        : ds.overdue ? 'overdue' : 'unpaid';
      kw.appendChild(kvRow('Statement', fmtDate(k.periodTo)));
      kw.appendChild(kvRow('Total bill', fmtMoney(k.total)));
      kw.appendChild(kvRow('Minimum due', fmtMoney(k.minimumDue)));
      kw.appendChild(kvRow('Due date', dueText));
      kw.appendChild(kvRow('Paid', fmtMoney(ds.paid)));
      kw.appendChild(kvRow('Outstanding', fmtMoney(ds.outstanding)));
      kw.appendChild(kvRow('Status', status));
    } else {
      kw.appendChild(kvRow('Statement', 'not imported yet'));
      kw.appendChild(kvRow('Total bill', '—'));
    }
    /* a number of 8 digits or less is shown as-is (e.g. just the last four:
     * "8311"), never "8311 … 8311" */
    var cno = C.card.no || '';
    var cardRow = el('div');
    cardRow.appendChild(el('b', '', 'Profile card'));
    var cardVal = el('button', cno ? 'primary small' : 'primary', cno ? (cno.length <= 8 ? cno : cno.slice(0, 4) + ' … ' + cno.slice(-4)) : 'not set — tap to set');
    cardVal.title = 'Tap to set or change the card number used to verify imports.';
    cardVal.onclick = function () { cardProfile(); };
    cardRow.appendChild(cardVal);
    kw.appendChild(cardRow);
    h.appendChild(kw);

    /* Next bill (est.): separate from the current printed bill. Unbilled =
     * ledger spend not yet reconciled to any statement (the reconciled flag is
     * authoritative), NOT a date cutoff: the bank's cut-off means a statement
     * omits txns near its period end (an 18/09 statement only prints through
     * 15/09), so spend dated *before* periodTo can still land on the next bill. */
    var coins = { base: 0, upi: 0, grocery: 0, tata: 0, tatagroc: 0 };
    C.ledger.forEach(function (e) {
      if (e.reconciled) return; // already booked on a statement
      if (e.category === 'payment') return; // a payment is a credit, not new spend
      if (e.category in coins) coins[e.category] += Calc.predictedCoins(e).coins;
    });
    /* estimate for the NEXT bill — single source of truth (Calc.estimatedDue):
     * carried + unbilled + finance, rounded UP to a whole rupee so it lines
     * up with the printed TOTAL AMOUNT DUE, plus the 5% min-due formula. */
    var est = Calc.estimatedDue(C.records, C.ledger);
    var unbilled = est.unbilled, carried = est.carried, finEst = est.finEst;
    var hasCoins = isNeu() && Object.keys(coins).some(function (c) { return coins[c] > 0; });
    /* a card with a statement always shows the block (even at ₹0 unbilled); a
     * statement-less card (Axis Scapia) shows it only once it has unbilled spend. */
    if (k || unbilled > 0 || hasCoins) {
      h.appendChild(el('h4', '', 'Next bill (est.)'));
      var up = el('div', 'kv');
      if (k) {
        up.appendChild(kvRow('Estimated total', fmtMoney(est.total)));
        up.appendChild(kvRow('Min due (est.)', fmtMoney(est.minDue)));
      }
      up.appendChild(kvRow('Unbilled (new spend)', fmtMoney(unbilled)));
      if (k) {
        up.appendChild(kvRow('Carried forward', fmtMoney(carried)));
        if (finEst > 0) up.appendChild(kvRow('Finance (est.)', fmtMoney(finEst)));
      }
      if (isNeu()) {
        var coinLine = Object.keys(coins).filter(function (c) { return coins[c] > 0; })
          .map(function (c) { return c + ' +' + fmtCoins(coins[c]) }).join(' · ') || 'no coins yet';
        up.appendChild(kvRow('Coins still earnable', coinLine));
        /* grand totals over unbilled entries: base coins (the 1.5%-type
         * portion — base/grocery + UPI's 1% app part + BigBasket's grocery
         * part) and the total the bill will earn (base + all bonus). */
        var ct = Calc.coinTotals(C.ledger.filter(function (e) { return !e.reconciled && e.category !== 'payment'; }));
        up.appendChild(kvRow('Coins — base (unbilled)', fmtCoins(ct.base)));
        up.appendChild(kvRow('Coins — total (est.)', fmtCoins(ct.total)));
      }
      h.appendChild(up);
    }
    if (C.records.length) {
      h.appendChild(el('h4', '', 'History'));
      var t = el('div', 'table');
      var recs = C.records.slice().sort(function (a, b) { return (Calc.pdate(b.periodTo) || 0) - (Calc.pdate(a.periodTo) || 0); });
      recs.slice(0, S.histCount).forEach(function (r) {
        var row = el('div', 'lrow');
        row.appendChild(el('span', 'l-date', fmtDate(r.periodTo)));
        var dsc = el('span', 'l-desc', 'total ' + fmtMoney(r.total) + ' · purchased ' + fmtMoney(r.purchases) + ' · coins ' + fmtCoins(r.closingNeuCoins));
        /* est-vs-actual: the estimate Home was showing before this statement
         * was imported (recorded at import time) vs the printed total due. */
        if (r.estimated && isFinite(r.estimated.total) && r.estimated.base && r.estimated.base !== r.periodTo) {
          var delta = Math.round(r.total) - r.estimated.total;
          dsc.appendChild(el('span', 'meta', ' · est ' + fmtMoney(r.estimated.total) + (delta === 0 ? ' ✓' : ' (' + (delta > 0 ? '+' : '−') + Math.abs(delta) + ')')));
        }
        if (r.reconciled) dsc.appendChild(el('span', 'tick', ' ✓ reconciled'));
        if (r.accepted && r.accepted.length) dsc.appendChild(el('span', 'meta', r.accepted.length + ' exception(s)'));
        row.appendChild(dsc);
        if (!r.reconciled) {
          var btn = el('button', 'small', 'Reconcile');
          btn.onclick = function () { openReconcile(r); };
          row.appendChild(btn);
          var res = Calc.reconcile(r, C.ledger, prevRecordOf(r));
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
      if (recs.length > S.histCount) {
        var more = el('button', 'small', 'Show ' + Math.min(3, recs.length - S.histCount) + ' more');
        more.onclick = function () { S.histCount += 3; renderLanding(); };
        h.appendChild(more);
      }
    } else {
      h.appendChild(el('p', 'muted', 'No statements recorded. Use “Import statement” above to import your HDFC Neu statement PDF and start verifying.'));
    }
    $('landingStats').replaceChildren(h);
    $('importCounter').textContent = C.records.length ? 'Stored: ' + C.records.length + ' · last ' + fmtDate(C.records[C.records.length - 1].periodTo) : 'No statements stored yet.';
  }
  function removeRecord(r) {
    var box = el('div');
    box.appendChild(el('h2', '', 'Remove statement?'));
    box.appendChild(el('p', '', 'Delete the record for ' + r.periodTo + ' (' + fmtMoney(r.total) + '). Matched ledger entries will keep their ✓.'));
    var ok = el('button', 'danger', 'Remove');
    ok.onclick = function () {
      C.records = C.records.filter(function (x) { return x.id !== r.id; });
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
    return '/* Credit Card Tracker data bundle v' + (DATA.version || 1) + ' (multi-card) — regenerate via Save bundle. */\nwindow.DATA = ' +
      JSON.stringify(DATA, null, 1) + ';\n';
  }
  function saveBundle() {
    var d = new Date();
    var ymd = String(d.getFullYear()) + (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1) + (d.getDate() < 10 ? '0' : '') + d.getDate();
    download('neu_tracker_' + ymd + '.js', bundleText(), 'text/javascript');
    toast('Bundle downloaded as neu_tracker_' + ymd + '.js. Replace data/bundle.js to make this folder portable.', 'ok');
  }
  function loadBundleFile(file) {
    file.text().then(function (t) {
      var s = String(t), d;
      if (s.indexOf('window.DATA =') >= 0) {
        s = s.replace(/^[\s\S]*?window\.DATA\s*=\s*/, '').replace(/;\s*$/, '');
        d = JSON.parse(s);
      } else {
        d = JSON.parse(s); // also accept a bare JSON bundle (renamed/extracted backup)
      }
      /* v6 stores data per-card in cards[]; older bundles have top-level
       * records/ledger. Accept either — migrateBundle normalizes both. */
      if (!d || (!Array.isArray(d.records) && !Array.isArray(d.ledger) && !Array.isArray(d.cards))) throw new Error('not a bundle');
      var migrated = Calc.migrateBundle(d);
      if (migrated.incompatible) { toast('Bundle is from a newer app version — update first.', 'bad'); return; }
      DATA = migrated;
      window.DATA = migrated;
      C = activeCard();
      persist();
      renderCardSwitcher();
      renderAll();
      toast('Bundle loaded: ' + C.records.length + ' statements, ' + C.ledger.length + ' ledger entries.', 'ok');
    }, function (e) { toast('Could not read bundle: ' + e.message, 'bad'); }).catch(function (e) { toast('Invalid bundle file: ' + e.message, 'bad'); });
  }

  /* ---------------- wiring ---------------- */
  function showView(id) {
    /* statement import is Tata-Neu specific — block it for a generic (non-neu)
     * card like Axis Scapia. */
    if (id === 'import') { if (!isNeu()) { toast('Import is Neu-specific for now.', 'warn'); return; } showView('landing'); $('importFile').click(); return; }
    show(id); renderAll();
  }

  /* ---------------- multi-card: switch / add profile ---------------- */
  function cardNameLabel(c) {
    var no = c.card.no || '';
    return c.name + (no ? (no.length <= 8 ? ' · ' + no : ' · …' + no.slice(-4)) : '');
  }
  function renderCardSwitcher() {
    var box = $('cardBox');
    if (!box) return;
    var sel = el('select', 'cardsel');
    sel.title = 'Switch the active card profile';
    DATA.cards.forEach(function (c) {
      var o = el('option'); o.value = c.id; o.textContent = cardNameLabel(c);
      if (c.id === DATA.activeCardId) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { switchCard(sel.value); });
    box.replaceChildren(sel);
    /* statement import is Tata-Neu specific — disable that nav button for a
     * generic (non-neu) card. */
    var neu = isNeu();
    $('importGo').disabled = !neu;
    $('importGo').title = neu ? '' : 'Statement import is Neu-specific (Axis parser comes later)';
  }
  function switchCard(id) {
    var c = DATA.cards.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    DATA.activeCardId = c.id;
    C = c;
    S.editing = null;
    persist();
    renderCardSwitcher();
    rebuildCategoryOptions();
    renderAll();
  }
  function addCard() {
    var box = el('div');
    box.appendChild(el('h2', '', 'Add card profile'));
    box.appendChild(el('p', 'muted', 'Name it (e.g. "Axis Scapia"). It starts empty — add ledger entries to it from the Ledger view.'));
    var nameInp = el('input'); nameInp.placeholder = 'Card name';
    var typeSel = el('select');
    var g = el('option'); g.value = 'generic'; g.textContent = 'Generic (ledger only)';
    var n = el('option'); n.value = 'neu'; n.textContent = 'Tata Neu (rewards + import)';
    typeSel.appendChild(g); typeSel.appendChild(n);
    var row = el('div', 'form');
    row.appendChild(nameInp); row.appendChild(typeSel);
    box.appendChild(row);
    var ok = el('button', 'primary', 'Add');
    ok.onclick = function () {
      var name = String(nameInp.value).trim() || 'Credit card';
      var nc = Calc.newCard(typeSel.value, name);
      DATA.cards.push(nc);
      switchCard(nc.id);
      closeModal();
      toast('Added ' + nc.name, 'ok');
    };
    box.appendChild(el('div', 'form'));
    box.lastChild.appendChild(ok);
    modal(box, true);
  }

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
    renderCardSwitcher();
    $('addCardBtn').addEventListener('click', addCard);
    $('delCardBtn').addEventListener('click', deleteCard);
    $('homeGo').addEventListener('click', function () { showView('landing'); });
    $('ledgerGo').addEventListener('click', function () { showView('ledger'); });
    $('importGo').addEventListener('click', function () { showView('import'); });
    $('addBtn').addEventListener('click', addEntry);
    $('leCat').addEventListener('change', function () { $('leHint').textContent = hintFor($('leCat').value); });
    rebuildCategoryOptions();
    $('leDate').value = todayISO();
    $('editCancelBtn').addEventListener('click', cancelEdit);
    $('rcSel').addEventListener('change', renderReconcile);
    $('commitBtn').addEventListener('click', commitStatement);
    $('discardBtn').addEventListener('click', function () { showView('landing'); toast('Discarded.', 'warn'); });
    $('leCat').addEventListener('change', function () {
      /* the "For period" picker only makes sense for Payment entries — the
       * repayment that clears a specific bill */
      $('lePeriodWrap').style.display = $('leCat').value === 'payment' ? '' : 'none';
      lePeriodOptions();
    });
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

  App.renderLedger = renderLedger;
  window.App = App;
})();