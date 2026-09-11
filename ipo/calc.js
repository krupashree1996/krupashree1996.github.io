var Calc = (function () {
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function dateAdd(iso, days) {
    if (!iso) return '';
    var p = iso.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2] + days);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function fmtDate(iso) {
    if (!iso) return '\u2014';
    var p = iso.split('-');
    var mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+p[1] - 1] || p[1];
    return (+p[2]) + ' ' + mo + ' ' + p[0];
  }
  function groupIn(n) {
    var s = String(Math.round(n));
    var neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    if (s.length <= 3) return (neg ? '-' : '') + s;
    var out = s.slice(-3);
    var rest = s.slice(0, -3);
    while (rest.length > 2) { out = rest.slice(-2) + ',' + out; rest = rest.slice(0, -2); }
    if (rest.length) out = rest + ',' + out;
    return (neg ? '-' : '') + out;
  }
  function fmtNum(n) {
    if (n == null || isNaN(n)) return '\u2014';
    return groupIn(n);
  }
  function inr(n) {
    if (n == null || isNaN(n)) return '\u2014';
    return (n < 0 ? '\u2212' : '') + '\u20B9' + groupIn(Math.abs(n));
  }
  function strip(x) { return String(+x.toFixed(2)); }
  function compact(n) {
    if (n == null || isNaN(n)) return '\u2014';
    var neg = n < 0, a = Math.abs(n);
    var pre = (neg ? '\u2212' : '') + '\u20B9';
    if (a >= 1e7) return pre + strip(a / 1e7) + 'Cr';
    if (a >= 1e5) return pre + strip(a / 1e5) + 'L';
    if (a >= 1000) return pre + strip(a / 1000) + 'k';
    return inr(n);
  }
  function price(n) {
    if (n == null || isNaN(n)) return '\u2014';
    return '\u20B9' + strip(n);
  }
  function fmtSubs(n) {
    if (n == null || isNaN(n)) return '\u2014';
    return strip(n) + '\u00D7';
  }
  function uid(p) {
    return p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function ipoStatus(ipo, today) {
    today = today || todayISO();
    var o = ipo.openDate, c = ipo.closeDate, l = ipo.listingDate;
    if (!o) return ipo.status || 'watch';
    if (today < o) return 'upcoming';
    if (!c || today <= c) return 'open';
    if (l && today >= l) return 'listed';
    return 'closed';
  }
  function calRank(ipo, today) {
    var r = { open: 0, upcoming: 1, watch: 2, closed: 3, listed: 4 }[ipoStatus(ipo, today)];
    return r == null ? 3 : r;
  }
  function sortIpos(ipos, today) {
    return (ipos || []).slice().sort(function (a, b) {
      var ra = calRank(a, today), rb = calRank(b, today);
      if (ra !== rb) return ra - rb;
      var dir = (ra === 3 || ra === 4) ? -1 : 1;
      var hasDa = !!a.openDate, hasDb = !!b.openDate;
      if (hasDa !== hasDb) return hasDa ? -1 : 1;
      if (!hasDa) return (a.name || '').localeCompare(b.name || '');
      if (a.openDate !== b.openDate) return (a.openDate < b.openDate ? -1 : 1) * dir;
      return (a.name || '').localeCompare(b.name || '');
    });
  }
  function sharesOf(app, ipo) {
    if (app.status !== 'allotted') return 0;
    if (app.shares) return app.shares;
    return (app.lots || 0) * ((ipo && ipo.shareLot) || 0);
  }
  function qtyOf(app, ipo) {
    return (app.lots || 0) * ((ipo && ipo.shareLot) || 0);
  }
  function offerPrice(app, ipo) {
    var p = app && app.price;
    if (p == null || !(p > 0)) p = ipo && ipo.bandHi;
    return p && p > 0 ? p : 0;
  }
  function lienAmount(app, ipo) {
    if (!ipo || !ipo.shareLot) return 0;
    if (app.status === 'rejected') return 0;
    var qty = app.status === 'allotted' ? sharesOf(app, ipo) : qtyOf(app, ipo);
    if (!(qty > 0)) return 0;
    return Math.round(qty * offerPrice(app, ipo));
  }
  function effPrice(app, ipo) {
    var p = app.soldPrice;
    if (p == null || p <= 0) p = ipo && ipo.listingPrice;
    return p && p > 0 ? p : 0;
  }
  function pnlOf(app, ipo) {
    var s = sharesOf(app, ipo);
    if (!s) return 0;
    var base = offerPrice(app, ipo);
    if (!base || !effPrice(app, ipo)) return 0;
    return Math.round((effPrice(app, ipo) - base) * s);
  }
  function appAmount(ipo, lots) {
    if (!ipo || !ipo.bandHi || !ipo.shareLot) return 0;
    return Math.round(ipo.bandHi * ipo.shareLot * (lots || 0));
  }
  function minAmount(ipo) { return appAmount(ipo, ipo.minLots || 1); }
  function defaultLots(category, ipo) {
    if (category === 'SME') {
      var amt = (ipo && ipo.bandHi > 0 && ipo.shareLot > 0) ? ipo.bandHi * ipo.shareLot : 0;
      if (amt > 0) return Math.max(1, Math.ceil(200000 / amt));
      return 1;
    }
    return 1;
  }
  function allotmentDue(app, ipo, today) {
    if (!app || app.status !== 'applied') return false;
    if (!ipo || !ipo.closeDate) return false;
    return (today || todayISO()) > ipo.closeDate;
  }
  function normRemote(r) {
    if (!r || typeof r !== 'object') return null;
    var isExternal = typeof r.companyName === 'string' || !!(r.priceBand && typeof r.priceBand === 'object');
    if (isExternal) {
      var band = r.priceBand || {};
      var name = (r.companyName || r.name || '').trim();
      if (!name || !(band.max > 0)) return null;
      var times = r.subscription ? r.subscription.timesSubscribed : null;
      return {
        name: name,
        symbol: r.symbol || null,
        exchange: Array.isArray(r.exchanges) ? r.exchanges.filter(Boolean).join(', ') : (r.exchange || null),
        category: String(r.series || '').toUpperCase() === 'SME' ? 'SME' : 'Mainline',
        bandHi: +band.max,
        shareLot: r.lotSize != null ? +r.lotSize : null,
        minLots: 1,
        openDate: r.issueStartDate || r.openDate || null,
        closeDate: r.issueEndDate || r.closeDate || null,
        refundDate: r.allotmentDate || r.refundDate || null,
        listingDate: r.listingDate || null,
        registrar: r.registrar || null,
        rhp: null,
        gmp: null,
        subs: times != null ? +times : null
      };
    }
    if (!(r.name || '').trim() || !(r.bandHi > 0)) return null;
    var cat = r.category != null ? r.category : (r.board != null ? r.board : '');
    if (/^mainboard$/i.test(cat)) cat = 'Mainline';
    if (/^sme$/i.test(cat)) cat = 'SME';
    return {
      name: r.name,
      symbol: r.symbol || null,
      exchange: r.exchange || null,
      category: cat || null,
      bandHi: +r.bandHi,
      shareLot: r.shareLot != null ? +r.shareLot : null,
      minLots: r.minLots != null ? +r.minLots : null,
      openDate: r.openDate || null,
      closeDate: r.closeDate || null,
      refundDate: r.refundDate || null,
      listingDate: r.listingDate || null,
      registrar: r.registrar || null,
      rhp: r.rhp || null,
      gmp: r.gmp != null ? +r.gmp : null,
      subs: r.subs != null ? +r.subs : null
    };
  }
  function validIpo(o) {
    var e = [];
    if (!(o.name || '').trim()) e.push('Company name is required.');
    if (!(o.bandHi > 0)) e.push('Price (max) is required.');
    if (!(o.shareLot > 0)) e.push('Shares per lot is required.');
    if (o.openDate && o.closeDate && o.closeDate < o.openDate) e.push('Close date is before open date.');
    if (o.listingDate && o.closeDate && o.listingDate < o.closeDate) e.push('Listing date is before close date.');
    return e;
  }
  function validApp(a, ipo) {
    var e = [];
    if (!ipo) e.push('Choose an IPO.');
    if (!(a.lots > 0)) e.push('Number of lots must be at least 1.');
    if (!(offerPrice(a, ipo) > 0)) e.push('Offer price (per share) is required.');
    if (a.status === 'allotted' && !(a.shares > 0)) e.push('Allotted shares must be positive.');
    return e;
  }
  function normPan(p) {
    return String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  function validPan(o) {
    var e = [];
    if (normPan(o.pan).length !== 10) e.push('PAN must be exactly 10 characters (letters and digits).');
    if (!(o.name || '').trim()) e.push('Holder name is required.');
    return e;
  }
  function hasApp(apps, ipoId, panId, excludeId) {
    return (apps || []).some(function (a) {
      if (excludeId && a.id === excludeId) return false;
      return a.ipoId === ipoId && a.panId === panId;
    });
  }
  function cleanupDue(ipo, apps, days, today) {
    if (!ipo) return false;
    for (var i = 0; i < (apps || []).length; i++) {
      var st = apps[i].status;
      if (st !== 'allotted' && st !== 'rejected') return false;
    }
    var ref = ipo.listingDate || ipo.closeDate || ipo.openDate;
    if (!ref) return false;
    return ref < dateAdd(today || todayISO(), -(days || 45));
  }
  function cleanupCandidates(ipos, applications, days, today) {
    var out = [];
    (ipos || []).forEach(function (ipo) {
      if (cleanupDue(ipo, applications.filter(function (a) { return a.ipoId === ipo.id; }), days, today)) out.push(ipo);
    });
    return out;
  }
  function ipoSummary(ipo, apps) {
    var s = { apps: 0, lots: 0, lien: 0, shares: 0, listValue: 0, pnl: 0, allotted: 0 };
    apps.forEach(function (a) {
      s.apps++;
      s.lots += a.lots || 0;
      s.lien += lienAmount(a, ipo);
      var sh = sharesOf(a, ipo);
      s.shares += sh;
      if (sh) s.allotted++;
      var p = effPrice(a, ipo);
      if (sh && p > 0) s.listValue += Math.round(p * sh);
      s.pnl += pnlOf(a, ipo);
    });
    return s;
  }
  return {
    todayISO: todayISO, dateAdd: dateAdd, fmtDate: fmtDate,
    groupIn: groupIn, fmtNum: fmtNum, inr: inr, compact: compact, price: price, fmtSubs: fmtSubs,
    uid: uid, ipoStatus: ipoStatus, calRank: calRank, sortIpos: sortIpos, sharesOf: sharesOf, qtyOf: qtyOf,
    offerPrice: offerPrice, lienAmount: lienAmount, effPrice: effPrice,
    pnlOf: pnlOf, appAmount: appAmount, minAmount: minAmount, defaultLots: defaultLots, allotmentDue: allotmentDue, normRemote: normRemote,
    validIpo: validIpo, validApp: validApp, normPan: normPan, validPan: validPan, hasApp: hasApp,
    cleanupDue: cleanupDue, cleanupCandidates: cleanupCandidates,
    ipoSummary: ipoSummary
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Calc;