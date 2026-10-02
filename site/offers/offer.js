(function () {
  var $ = function (s) { return document.querySelector(s); };
  var form = $('#book-form'), btn = $('#book-btn'), status = $('#status'), total = $('#total'), sessionsBox = $('#sessions');
  if (!form) return;
  var slug = location.pathname.split('/').filter(function (p) { return p; })[1] || '';
  var offer = null;

  var DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function money(c) { return '$' + (c / 100).toFixed(c % 100 ? 2 : 0); }
  function shortDate(s) { var p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2])); return DAY[d.getUTCDay()] + ' ' + MON[p[1] - 1] + ' ' + p[2]; }
  function hm12(s) {
    var p = s.split(':').map(Number), h = p[0] % 12 === 0 ? 12 : p[0] % 12, ap = p[0] < 12 ? 'am' : 'pm';
    return p[1] ? h + ':' + (p[1] < 10 ? '0' : '') + p[1] + ' ' + ap : h + ' ' + ap;
  }
  function duration(m) { if (!m) return ''; if (m % 60 === 0) { var h = m / 60; return h + (h === 1 ? ' hour' : ' hours'); } return m + ' minutes'; }
  function seatsText(s) {
    if (s.bookable) return s.remaining === 1 ? '1 seat left' : s.remaining + ' seats left';
    return s.remaining === 0 ? 'Sold out' : 'Closed';
  }

  // D51: the Meta Pixel loads here and on the thanks page only, and only with an id.
  function loadPixel(id) {
    if (!id || window.fbq) return;
    !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    // D51: no automatic form-field or button collection; only the events we fire.
    window.fbq('set', 'autoConfig', false, id);
    window.fbq('init', id);
    window.fbq('track', 'PageView');
  }

  function showUnavailable() {
    $('#loading').hidden = true; $('#offer').hidden = true; $('#unavailable').hidden = false;
    document.title = 'Not currently offered — The Bull and Bloom';
  }

  function chosenSession() { var f = new FormData(form); return f.get('sessionId'); }
  function refreshTotal() {
    var ok = !!(offer && chosenSession());
    total.textContent = ok ? money(offer.priceCents) + ' for one seat · tax added at checkout' : '';
    btn.disabled = !ok;
  }

  function renderSessions() {
    sessionsBox.querySelectorAll('label').forEach(function (l) { l.remove(); });
    var open = offer.sessions.filter(function (s) { return s.bookable; });
    offer.sessions.forEach(function (s, i) {
      var lab = document.createElement('label');
      if (!s.bookable) lab.className = 'off';
      lab.innerHTML = '<input type="radio" name="sessionId"><span></span>';
      var inp = lab.querySelector('input'); inp.value = s.id; inp.disabled = !s.bookable;
      inp.setAttribute('form', 'book-form');
      inp.checked = s.bookable && open[0] && open[0].id === s.id;
      lab.querySelector('span').textContent = shortDate(s.date) + ' · ' + hm12(s.start) + ' · ' + seatsText(s);
      inp.setAttribute('aria-label', shortDate(s.date) + ' at ' + hm12(s.start) + ', ' + seatsText(s));
      sessionsBox.appendChild(lab);
    });
    $('#booking').hidden = open.length === 0;
    $('#no-dates').hidden = open.length > 0;
    refreshTotal();
  }

  function render() {
    document.title = offer.name + ' — The Bull and Bloom';
    $('#name').textContent = offer.name;
    $('#tagline').textContent = offer.tagline;
    if (offer.image) { $('#image').onerror = function () { $('#photo').hidden = true; }; $('#image').src = '/' + offer.image; $('#image').alt = offer.imageAlt || ''; $('#photo').hidden = false; }
    $('#description').textContent = offer.description;
    var len = duration(offer.durationMinutes);
    $('#facts').textContent = money(offer.priceCents) + ' per seat' + (len ? ' · ' + len : '');
    renderSessions();
    $('#loading').hidden = true; $('#unavailable').hidden = true; $('#offer').hidden = false;
  }

  function load() {
    return fetch('/api/offers').then(function (r) { return r.json(); }).then(function (data) {
      offer = (data.offers || []).filter(function (o) { return o.slug === slug; })[0] || null;
      if (!offer) { showUnavailable(); return; }
      loadPixel(data.marketing && data.marketing.metaPixelId);
      render();
    }).catch(function () {
      $('#load-status').textContent = 'The page is briefly unavailable. Email thebullandbloom@gmail.com to book.';
    });
  }

  sessionsBox.addEventListener('change', refreshTotal);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = new FormData(form);
    if (!chosenSession()) { status.textContent = 'Pick a date.'; return; }
    if (!form.reportValidity()) return;
    btn.disabled = true; status.textContent = 'One moment…';
    fetch('/api/book', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        offerId: offer.id, sessionId: chosenSession(),
        customer: { name: f.get('name'), email: f.get('email'), phone: f.get('phone') || undefined },
        note: f.get('note') || undefined
      })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function (r) {
        if (r.ok) { window.location.href = r.body.url; return; }
        btn.disabled = false;
        var err = r.body && r.body.error;
        if (err === 'sold_out') { status.textContent = 'That date just filled up. Pick another.'; load(); }
        else if (err === 'closed') { status.textContent = 'Bookings for that date have closed. Pick another.'; load(); }
        else if (err === 'disabled') { showUnavailable(); }
        else if (r.status === 503) { status.textContent = 'Payments are down, try again in a minute.'; }
        else { status.textContent = err || 'Something went wrong.'; }
      })
      .catch(function () { btn.disabled = false; status.textContent = 'Something went wrong. Try again.'; });
  });

  load();
})();
