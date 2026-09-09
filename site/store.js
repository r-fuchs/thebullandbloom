(function () {
  var $ = function (s) { return document.querySelector(s); };
  var menu = $('#menu'), sizes = $('#size-picker'), days = $('#day-picker'), dayNote = $('#day-note');
  var form = $('#order-form'), pay = $('#pay-btn'), status = $('#order-status');
  var fulfil = $('#fulfillment-picker'), deliveryFields = $('#delivery-fields');
  var quoteNote = $('#quote-note'), phoneHint = $('#phone-hint'), totalLine = $('#order-total');
  if (!form) return;

  // The last accepted quote: token is what checkout trusts (the fee is signed into it, so the
  // browser cannot change the price). Cleared whenever the address or day changes.
  var quote = null;      // { feeCents: number, token: string, kind: 'uber'|'fallback' }
  var quoteSeq = 0;      // guards against a slow response overwriting a newer one
  var quoteTimer = null;
  var deliveryOffered = false;
  var priceBySize = {};

  function money(c) { return '$' + (c / 100).toFixed(c % 100 ? 2 : 0); }
  function ymd(d) { return d.toISOString().slice(0, 10); }
  function human(s) {
    var p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  function val(name) { var el = form.elements[name]; return el && el.value ? el.value.trim() : ''; }
  function isDelivery() { return form.elements['fulfillment'] && form.elements['fulfillment'].value === 'delivery'; }

  function renderSizes(cfg) {
    menu.innerHTML = '';
    sizes.querySelectorAll('label').forEach(function (l) { l.remove(); });
    priceBySize = {};
    cfg.sizes.forEach(function (s, i) {
      priceBySize[s.id] = s.priceCents;
      var li = document.createElement('li');
      li.innerHTML = '<h3></h3><p></p><p class="price"></p>';
      li.querySelector('h3').textContent = s.name;
      li.querySelector('p').textContent = s.description;
      li.querySelector('.price').textContent = money(s.priceCents);
      menu.appendChild(li);
      var lab = document.createElement('label');
      lab.innerHTML = '<input type="radio" name="sizeId"><span></span>';
      lab.querySelector('input').value = s.id;
      lab.querySelector('input').checked = i === 0;
      lab.querySelector('span').textContent = s.name + ' · ' + money(s.priceCents);
      sizes.appendChild(lab);
    });
    deliveryOffered = !!(cfg.delivery && cfg.delivery.offered);
    fulfil.hidden = !deliveryOffered;
    applyFulfillment();
  }

  function renderDays(av) {
    days.querySelectorAll('label').forEach(function (l) { l.remove(); });
    var any = false;
    av.days.forEach(function (d) {
      if (!d.open) return;
      var lab = document.createElement('label');
      lab.innerHTML = '<input type="radio" name="date"><span></span>';
      var inp = lab.querySelector('input');
      inp.value = d.date;
      inp.disabled = !d.orderable;
      if (!d.orderable) lab.className = 'sold';
      lab.querySelector('span').textContent = human(d.date) + (d.orderable && d.remaining <= 2 ? ' · ' + d.remaining + ' left' : '');
      days.insertBefore(lab, dayNote);
      any = any || d.orderable;
    });
    dayNote.textContent = any ? 'Same-day orders close at the morning cutoff.' : 'Nothing open in the next few weeks. Email Anthony and he will find a day.';
    refreshTotal();
  }

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
    var el = form.querySelector('input[name="sizeId"]:checked');
    return el ? (priceBySize[el.value] || 0) : 0;
  }

  function refreshTotal() {
    var b = bouquetCents();
    var dayChosen = !!(new FormData(form)).get('date');
    if (!b || !dayChosen) { totalLine.textContent = ''; pay.disabled = true; return; }
    if (isDelivery()) {
      if (!quote) { totalLine.textContent = ''; pay.disabled = true; return; }
      totalLine.textContent = 'Bouquet ' + money(b) + ' + delivery ' + money(quote.feeCents) + ' = ' + money(b + quote.feeCents);
      pay.disabled = false;
      return;
    }
    totalLine.textContent = 'Total ' + money(b) + ' · pickup is free';
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
    if (quoteTimer) clearTimeout(quoteTimer);
    quoteTimer = setTimeout(askForQuote, 400);
  }

  form.addEventListener('change', function (e) {
    var n = e.target.name;
    if (n === 'fulfillment') { applyFulfillment(); askForQuote(); return; }
    if (n === 'sizeId' || n === 'date') { refreshTotal(); if (n === 'date') askForQuote(); return; }
    if (n === 'street' || n === 'unit' || n === 'city' || n === 'state' || n === 'zip') scheduleQuote();
  });
  form.addEventListener('input', function (e) {
    var n = e.target.name;
    if (n === 'street' || n === 'city' || n === 'state' || n === 'zip') scheduleQuote();
  });

  function load() {
    var today = new Date(), to = new Date(today.getTime() + 27 * 86400000);
    return Promise.all([
      fetch('/api/config').then(function (r) { return r.json(); }),
      fetch('/api/availability?from=' + ymd(today) + '&to=' + ymd(to)).then(function (r) { return r.json(); })
    ]).then(function (res) { renderSizes(res[0]); renderDays(res[1]); })
      .catch(function () { status.textContent = 'The store is briefly unavailable. Email thebullandbloom@gmail.com to order.'; });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = new FormData(form);
    if (!f.get('date')) { status.textContent = 'Pick a day.'; return; }
    if (isDelivery() && !quote) { status.textContent = 'We still need a delivery price for that address.'; return; }
    if (!form.reportValidity()) return;
    pay.disabled = true; status.textContent = 'One moment…';
    var body = {
      sizeId: f.get('sizeId'), date: f.get('date'), fulfillment: isDelivery() ? 'delivery' : 'pickup',
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
        if (r.status === 409) { status.textContent = 'That day just filled up. Pick another.'; load(); }
        else if (r.status === 503) { status.textContent = 'Payments are briefly unavailable. Try again in a minute.'; }
        else if (r.body.error === 'quote_expired') { status.textContent = 'That delivery price has expired. We are getting a fresh one.'; quote = null; askForQuote(); }
        else { status.textContent = r.body.error || 'Something went wrong.'; }
      })
      .catch(function () { pay.disabled = false; status.textContent = 'Something went wrong. Try again.'; });
  });

  load();
})();
