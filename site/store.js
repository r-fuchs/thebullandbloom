(function () {
  var $ = function (s) { return document.querySelector(s); };
  var menu = $('#menu'), cal = $('#cal'), dayNote = $('#day-note');
  var form = $('#order-form'), pay = $('#pay-btn'), status = $('#order-status');
  var fulfil = $('#fulfillment-picker'), deliveryFields = $('#delivery-fields');
  var quoteNote = $('#quote-note'), phoneHint = $('#phone-hint'), totalLine = $('#order-total');
  if (!form) return;

  // Delivery (Plan 3) rides on the one-time panel only; the subscription tab stays pickup-only.
  // The last accepted quote: `token` is what checkout trusts (the fee is signed into it, so the
  // browser cannot change the price). Cleared whenever the address, the day or the choice changes.
  var quote = null;      // { feeCents: number, token: string, kind: 'uber'|'fallback' }
  var quoteSeq = 0;      // guards against a slow response overwriting a newer one
  var quoteTimer = null;
  var deliveryOffered = false;

  function money(c) { return '$' + (c / 100).toFixed(c % 100 ? 2 : 0); }
  function ymd(d) { return d.toISOString().slice(0, 10); }
  function human(s) {
    var p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function val(name) { var el = form.elements[name]; return el && el.value ? el.value.trim() : ''; }
  function isDelivery() { return form.elements['fulfillment'] && form.elements['fulfillment'].value === 'delivery'; }
  function isVase() { return form.elements['presentation'] && form.elements['presentation'].value === 'vase'; }
  function sizeOf(id) { return cfgCache ? cfgCache.sizes.filter(function (x) { return x.id === id; })[0] : null; }
  function vaseCents() { var sz = sizeOf(state.sizeId); return sz && sz.vaseFeeCents ? sz.vaseFeeCents : 0; }
  function renderVaseLabel() { var el = $('#vase-label'); if (el) el.textContent = 'Arranged in a clear glass vase — +' + money(vaseCents()); }

  var state = { sizeId: null, tab: 'once' };
  var cfgCache = null;
  function priceFor(sizeId) {
    if (!cfgCache) return null;
    if (state.tab === 'once') { var sz = cfgCache.sizes.filter(function (x) { return x.id === sizeId; })[0]; return sz ? { cents: sz.priceCents, per: '' } : null; }
    var cad = subForm ? (new FormData(subForm)).get('cadenceId') : null;
    var cell = cfgCache.subscriptions.cells.filter(function (c) { return c.sizeId === sizeId && c.cadenceId === cad; })[0];
    return cell ? { cents: cell.priceCents, per: ' / month' } : null;
  }
  function renderCardPrices() {
    menu.querySelectorAll('li').forEach(function (li) {
      var p = priceFor(li.getAttribute('data-size'));
      var el = li.querySelector('.price');
      if (p) { el.innerHTML = ''; el.appendChild(document.createTextNode(money(p.cents))); if (p.per) { var per = document.createElement('span'); per.className = 'per'; per.textContent = p.per; el.appendChild(per); } }
      else el.textContent = 'Not offered';
      li.classList.toggle('chosen', li.getAttribute('data-size') === state.sizeId);
    });
    var once = $('#once-size'), sub = $('#sub-size-input');
    if (once) once.value = state.sizeId || ''; if (sub) sub.value = state.sizeId || '';
    if (subForm) renderSubPrice();
  }
  function chooseSize(id) { state.sizeId = id; renderCardPrices(); renderVaseLabel(); refreshTotal(); }
  function renderSizes(cfg) {
    cfgCache = cfg;
    menu.innerHTML = '';
    if (!state.sizeId) state.sizeId = (cfg.sizes[1] || cfg.sizes[0]).id;
    cfg.sizes.forEach(function (s) {
      var li = document.createElement('li');
      li.setAttribute('data-size', s.id); li.setAttribute('role', 'button'); li.tabIndex = 0;
      li.innerHTML = '<span class="tick" aria-hidden="true"></span><h3></h3><p></p><p class="price"></p>';
      li.querySelector('h3').textContent = s.name;
      li.querySelector('p').textContent = s.description;
      li.addEventListener('click', function () { chooseSize(s.id); });
      li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseSize(s.id); } });
      menu.appendChild(li);
    });
    renderCardPrices();
    deliveryOffered = !!(cfg.delivery && cfg.delivery.offered);
    fulfil.hidden = !deliveryOffered;
    renderVaseLabel();
    applyFulfillment();
  }

  // ---- pickup or delivery (Plan 3). One-time purchases only.

  /** Show or hide the address block and make the phone required for delivery (Uber needs it). */
  function applyFulfillment() {
    var d = isDelivery();
    deliveryFields.hidden = !d;
    form.elements['phone'].required = d;
    phoneHint.textContent = d ? '(the courier may call)' : '(optional)';
    ['street', 'city', 'state', 'zip'].forEach(function (n) { form.elements[n].required = d; });
    if (!d) { quote = null; quoteNote.textContent = ''; }
    refreshTotal();
  }

  function addressComplete() {
    return val('street') !== '' && val('city') !== '' && /^[A-Za-z]{2}$/.test(val('state')) && /^\d{5}$/.test(val('zip'));
  }

  function bouquetCents() {
    if (!cfgCache || !state.sizeId) return 0;
    var sz = cfgCache.sizes.filter(function (x) { return x.id === state.sizeId; })[0];
    return sz ? sz.priceCents : 0;
  }

  /** The one place that decides what the total line says and whether Continue is live. */
  function refreshTotal() {
    var b = bouquetCents();
    var dayChosen = !!(new FormData(form)).get('date');
    if (!b || !dayChosen) { totalLine.textContent = ''; pay.disabled = true; return; }
    var sz = sizeOf(state.sizeId);
    var parts = [(sz ? sz.name : 'Bouquet') + ' ' + money(b)], total = b, v = vaseCents();
    if (isVase()) { parts.push('vase ' + money(v)); total += v; }
    if (isDelivery()) {
      if (!quote) { totalLine.textContent = ''; pay.disabled = true; return; }
      parts.push('delivery ' + money(quote.feeCents)); total += quote.feeCents;
    }
    var line = parts.length > 1 ? parts.join(' + ') + ' = ' + money(total) : 'Total ' + money(total);
    if (!isDelivery()) line += ' · pickup is free';
    totalLine.textContent = line + ' · tax added at checkout';
    pay.disabled = false;
  }

  function askForQuote() {
    if (!isDelivery()) return;
    var date = (new FormData(form)).get('date');
    quote = null;
    refreshTotal();
    if (!date) { quoteNote.textContent = 'Pick a day and we will price the delivery.'; return; }
    if (!addressComplete()) { quoteNote.textContent = 'Fill in the address and we will price the delivery.'; return; }
    quoteNote.textContent = 'Checking delivery…';
    var seq = ++quoteSeq;
    fetch('/api/quote', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        date: date,
        address: { street: val('street'), unit: val('unit'), city: val('city'), state: val('state').toUpperCase(), zip: val('zip') }
      })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (r) {
        if (seq !== quoteSeq) return;                  // a newer request is in flight
        if (r.ok && r.body.available) {
          quote = { feeCents: r.body.feeCents, token: r.body.quoteToken, kind: r.body.kind };
          quoteNote.textContent = 'Delivery ' + money(r.body.feeCents) +
            (r.body.zone ? ' (' + r.body.zone + ')' : '') +
            (r.body.estimate === true ? ' (estimated — priced as of today)' : '') +
            (r.body.kind === 'fallback' ? ' — Anthony delivers this one himself.' : '');
        } else {
          quote = null;
          quoteNote.textContent = r.ok && r.body.reason === 'outside_area'
            ? 'That address is outside our delivery area. Choose pickup, or email Anthony.'
            : 'We could not price a delivery just now. Choose pickup, or try again in a minute.';
        }
        refreshTotal();
      })
      .catch(function () {
        if (seq !== quoteSeq) return;
        quote = null;
        quoteNote.textContent = 'We could not price a delivery just now. Choose pickup, or try again in a minute.';
        refreshTotal();
      });
  }

  function scheduleQuote() {
    quote = null;
    refreshTotal();
    if (quoteTimer) clearTimeout(quoteTimer);
    quoteTimer = setTimeout(askForQuote, 400);
  }

  var ADDRESS_FIELDS = { street: 1, unit: 1, city: 1, state: 1, zip: 1 };
  form.addEventListener('change', function (e) {
    var n = e.target.name;
    if (n === 'presentation') { refreshTotal(); return; }
    if (n === 'fulfillment') { applyFulfillment(); askForQuote(); return; }
    if (n === 'date') { dayNote.textContent = 'Chosen: ' + human(e.target.value) + '. Same-day orders close at the morning cutoff.'; refreshTotal(); askForQuote(); return; }
    if (ADDRESS_FIELDS[n]) scheduleQuote();
  });
  form.addEventListener('input', function (e) {
    if (ADDRESS_FIELDS[e.target.name]) scheduleQuote();
  });

  function renderGallery(feed) {
    var box = $('#gallery'), row = $('#gallery-row'), dots = $('#gallery-dots');
    if (!box || !feed || !feed.posts || !feed.posts.length) return;
    row.innerHTML = ''; dots.innerHTML = '';
    feed.posts.forEach(function (p, i) {
      var a = document.createElement('a'); a.href = p.permalink; a.target = '_blank'; a.rel = 'noopener';
      var img = document.createElement('img'); img.src = p.url; img.loading = i < 3 ? 'eager' : 'lazy'; img.alt = p.caption ? p.caption.slice(0, 120) : 'A bouquet from The Bull and Bloom';
      a.appendChild(img);
      if (p.caption) { var c = document.createElement('span'); c.className = 'capline'; c.textContent = p.caption.slice(0, 90); a.appendChild(c); }
      row.appendChild(a);
      var d = document.createElement('i'); if (i === 0) d.className = 'on'; dots.appendChild(d);
    });
    var ticking = false;
    row.addEventListener('scroll', function () {
      if (ticking) return; ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var mid = row.scrollLeft + row.clientWidth / 2, best = 0, bestD = Infinity;
        Array.prototype.forEach.call(row.children, function (a, i) { var d = Math.abs(a.offsetLeft + a.offsetWidth / 2 - mid); if (d < bestD) { bestD = d; best = i; } });
        Array.prototype.forEach.call(dots.children, function (d, i) { d.className = i === best ? 'on' : ''; });
      });
    });
    box.hidden = false;
  }

  // ---- one-time / subscription tabs
  function showTab(which) {
    state.tab = which === 'sub' ? 'sub' : 'once';
    var cad = $('#sub-cadence'); if (cad) cad.hidden = state.tab !== 'sub';
    if (cfgCache) renderCardPrices();
    var once = which !== 'sub';
    $('#tab-once').setAttribute('aria-selected', String(once)); $('#tab-sub').setAttribute('aria-selected', String(!once));
    $('#panel-once').hidden = !once; $('#panel-sub').hidden = once;
  }
  if ($('#tab-once')) {
    $('#tab-once').addEventListener('click', function () { showTab('once'); });
    $('#tab-sub').addEventListener('click', function () { showTab('sub'); });
    if (location.hash === '#subscribe') { showTab('sub'); }
    window.addEventListener('hashchange', function () { if (location.hash === '#subscribe') { showTab('sub'); $('#order').scrollIntoView(); } });
  }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function addDays(s, n) { var p = s.split('-').map(Number); var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)); return d.toISOString().slice(0, 10); }
  function weekdayOf(s) { var p = s.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); }
  function renderDays(av) {
    cal.innerHTML = '';
    var byDate = {}, any = false;
    av.days.forEach(function (d) { byDate[d.date] = d; any = any || d.orderable; });
    if (!av.days.length) { dayNote.textContent = 'Nothing open in the next few weeks. Email Anthony and he will find a day.'; pay.disabled = true; return; }
    var HEAD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    HEAD.forEach(function (full) {
      var e = document.createElement('div'); e.className = 'h';
      e.innerHTML = '<span aria-hidden="true"></span><span class="sr"></span>';
      e.firstChild.textContent = full.charAt(0); e.lastChild.textContent = full;
      cal.appendChild(e);
    });
    var first = av.days[0].date, last = av.days[av.days.length - 1].date;
    var cur = first, month = '', col = 0, k, el;
    function blank() { var b = document.createElement('div'); b.className = 'd blank'; cal.appendChild(b); }
    while (cur <= last) {
      var m = cur.slice(0, 7);
      if (m !== month) {
        if (col > 0) { for (; col < 7; col++) blank(); col = 0; }
        month = m;
        el = document.createElement('div'); el.className = 'm'; el.textContent = MONTHS[Number(m.slice(5)) - 1]; cal.appendChild(el);
        for (k = 0; k < weekdayOf(cur); k++) { blank(); col++; }
      }
      var d = byDate[cur];
      if (!d) blank();
      else if (!d.open) { el = document.createElement('div'); el.className = 'd off'; el.textContent = Number(cur.slice(8)); cal.appendChild(el); }
      else {
        el = document.createElement('label'); el.className = 'd' + (d.orderable ? '' : ' sold');
        el.innerHTML = '<input type="radio" name="date"><span></span><small></small>';
        var inp = el.querySelector('input'); inp.value = cur; inp.disabled = !d.orderable;
        el.querySelector('span').textContent = Number(cur.slice(8));
        el.querySelector('small').textContent = d.orderable && d.remaining <= 2 ? d.remaining + ' left' : '';
        el.title = human(cur);
        inp.setAttribute('aria-label', human(cur) + (d.orderable ? (d.remaining <= 2 ? ', ' + d.remaining + ' left' : '') : ', sold out'));
        cal.appendChild(el);
      }
      col = (col + 1) % 7;
      cur = addDays(cur, 1);
    }
    dayNote.textContent = any ? 'Tap a day. Same-day orders close at the morning cutoff.' : 'Nothing open in the next few weeks. Email Anthony and he will find a day.';
    // Re-rendering the calendar drops whatever day was chosen, so refreshTotal owns the button.
    refreshTotal();
  }

  // ---- subscriptions (Plan 4)
  var subForm = $('#subscribe-form'), subBtn = $('#sub-btn'), subStatus = $('#sub-status'), subPrice = $('#sub-price');
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var subCfg = null;
  function radio(box, name, value, text, checked) {
    var lab = document.createElement('label');
    lab.innerHTML = '<input type="radio"><span></span>';
    var inp = lab.querySelector('input'); inp.name = name; inp.value = value; inp.checked = !!checked;
    if (name === 'cadenceId') inp.setAttribute('form', 'subscribe-form'); // the cadence pills live above the size cards, outside the form
    lab.querySelector('span').textContent = text;
    box.appendChild(lab);
    return inp;
  }
  function subChoice() {
    var f = new FormData(subForm);
    return { sizeId: state.sizeId, cadenceId: f.get('cadenceId'), weekday: f.get('weekday') };
  }
  function renderSubPrice() {
    if (!subCfg) return;
    var c = subChoice();
    var cell = null, i;
    for (i = 0; i < subCfg.cells.length; i++) if (subCfg.cells[i].sizeId === c.sizeId && subCfg.cells[i].cadenceId === c.cadenceId) cell = subCfg.cells[i];
    var size = null, cad = null;
    for (i = 0; i < subCfg.sizes.length; i++) if (subCfg.sizes[i].id === c.sizeId) size = subCfg.sizes[i];
    for (i = 0; i < subCfg.cadences.length; i++) if (subCfg.cadences[i].id === c.cadenceId) cad = subCfg.cadences[i];
    if (cell && size && cad) { subPrice.innerHTML = '<span></span> / month for a ' + size.name.toLowerCase() + ', ' + cad.name.toLowerCase(); subPrice.querySelector('span').textContent = money(cell.priceCents); }
    else subPrice.textContent = 'That combination is not offered.';
    subBtn.disabled = !cell;
  }
  function renderSubscription(cfg) {
    if (!subForm) return;
    subCfg = { sizes: cfg.sizes, cadences: cfg.subscriptions.cadences, cells: cfg.subscriptions.cells };
    var cadBox = $('#sub-cadence'), dayBox = $('#sub-day'), note = $('#sub-day-note');
    [cadBox, dayBox].forEach(function (b) { b.querySelectorAll('label').forEach(function (l) { l.remove(); }); });
    cfg.subscriptions.cadences.forEach(function (c, i) { radio(cadBox, 'cadenceId', c.id, c.name, i === 0); });
    cfg.openWeekdays.forEach(function (d, i) { var lab; radio(dayBox, 'weekday', String(d), DAYS[d], i === 0); });
    dayBox.querySelectorAll('label').forEach(function (l) { dayBox.insertBefore(l, note); });
    subForm.addEventListener('change', function () { renderCardPrices(); });
    cadBox.addEventListener('change', function () { renderCardPrices(); });
    renderSubPrice();
  }
  if (subForm) subForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = new FormData(subForm), c = subChoice();
    if (!c.sizeId) { subStatus.textContent = 'Pick a size.'; return; }
    if (!c.weekday) { subStatus.textContent = 'Pick a day.'; return; }
    if (!subForm.reportValidity()) return;
    subBtn.disabled = true; subStatus.textContent = 'One moment…';
    fetch('/api/subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sizeId: c.sizeId, cadenceId: c.cadenceId, weekday: Number(c.weekday),
        customer: { name: f.get('name'), email: f.get('email'), phone: f.get('phone') || undefined },
        note: f.get('note') || undefined
      })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function (r) {
        if (r.ok) { window.location.href = r.body.url; return; }
        subBtn.disabled = false;
        if (r.status === 503) subStatus.textContent = 'Payments are briefly unavailable. Try again in a minute.';
        else subStatus.textContent = r.body.error || 'Something went wrong.';
      })
      .catch(function () { subBtn.disabled = false; subStatus.textContent = 'Something went wrong. Try again.'; });
  });

  function load() {
    var today = new Date(), to = new Date(today.getTime() + 27 * 86400000);
    fetch('/api/feed').then(function (r) { return r.json(); }).then(renderGallery).catch(function () {});
    return Promise.all([
      fetch('/api/config').then(function (r) { return r.json(); }),
      fetch('/api/availability?from=' + ymd(today) + '&to=' + ymd(to)).then(function (r) { return r.json(); })
    ]).then(function (res) { renderSizes(res[0]); renderDays(res[1]); renderSubscription(res[0]); })
      .catch(function () { status.textContent = 'The store is briefly unavailable. Email thebullandbloom@gmail.com to order.'; });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = new FormData(form);
    if (!state.sizeId) { status.textContent = 'Pick a size.'; return; }
    if (!f.get('date')) { status.textContent = 'Pick a day.'; return; }
    if (isDelivery() && !quote) { status.textContent = 'We still need a delivery price for that address.'; return; }
    if (!form.reportValidity()) return;
    pay.disabled = true; status.textContent = 'One moment…';
    var body = {
      sizeId: state.sizeId, date: f.get('date'), fulfillment: isDelivery() ? 'delivery' : 'pickup',
      presentation: isVase() ? 'vase' : 'hand-tied',
      customer: { name: f.get('name'), email: f.get('email'), phone: f.get('phone') || undefined },
      note: f.get('note') || undefined
    };
    if (isDelivery()) {
      body.delivery = {
        address: { street: val('street'), unit: val('unit'), city: val('city'), state: val('state').toUpperCase(), zip: val('zip') },
        notes: val('deliveryNotes') || undefined,
        quoteToken: quote.token
      };
    }
    fetch('/api/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function (r) {
        if (r.ok) { window.location.href = r.body.url; return; }
        pay.disabled = false;
        if (r.body && r.body.error === 'quote_expired') { status.textContent = 'That delivery price has expired. We are getting a fresh one.'; quote = null; askForQuote(); }
        else if (r.status === 409) { status.textContent = 'That day just filled up. Pick another.'; load(); }
        else if (r.status === 503) { status.textContent = 'Payments are briefly unavailable. Try again in a minute.'; }
        else { status.textContent = r.body.error || 'Something went wrong.'; }
      })
      .catch(function () { pay.disabled = false; status.textContent = 'Something went wrong. Try again.'; });
  });

  load();
})();
