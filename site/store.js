(function () {
  var $ = function (s) { return document.querySelector(s); };
  var menu = $('#menu'), sizes = $('#size-picker'), cal = $('#cal'), dayNote = $('#day-note');
  var form = $('#order-form'), pay = $('#pay-btn'), status = $('#order-status');
  if (!form) return;

  function money(c) { return '$' + (c / 100).toFixed(c % 100 ? 2 : 0); }
  function ymd(d) { return d.toISOString().slice(0, 10); }
  function human(s) {
    var p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

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
  function chooseSize(id) { state.sizeId = id; renderCardPrices(); }
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
  }

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
    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function (h) { var e = document.createElement('div'); e.className = 'h'; e.textContent = h; cal.appendChild(e); });
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
        cal.appendChild(el);
      }
      col = (col + 1) % 7;
      cur = addDays(cur, 1);
    }
    dayNote.textContent = any ? 'Tap a day. Same-day orders close at the morning cutoff.' : 'Nothing open in the next few weeks. Email Anthony and he will find a day.';
    pay.disabled = !any;
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
    if (!form.reportValidity()) return;
    pay.disabled = true; status.textContent = 'One moment…';
    fetch('/api/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sizeId: state.sizeId, date: f.get('date'), fulfillment: 'pickup',
        customer: { name: f.get('name'), email: f.get('email'), phone: f.get('phone') || undefined },
        note: f.get('note') || undefined
      })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function (r) {
        if (r.ok) { window.location.href = r.body.url; return; }
        pay.disabled = false;
        if (r.status === 409) { status.textContent = 'That day just filled up. Pick another.'; load(); }
        else if (r.status === 503) { status.textContent = 'Payments are briefly unavailable. Try again in a minute.'; }
        else { status.textContent = r.body.error || 'Something went wrong.'; }
      })
      .catch(function () { pay.disabled = false; status.textContent = 'Something went wrong. Try again.'; });
  });

  load();
})();
