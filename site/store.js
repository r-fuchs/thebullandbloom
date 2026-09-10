(function () {
  var $ = function (s) { return document.querySelector(s); };
  var menu = $('#menu'), sizes = $('#size-picker'), days = $('#day-picker'), dayNote = $('#day-note');
  var form = $('#order-form'), pay = $('#pay-btn'), status = $('#order-status');
  if (!form) return;

  function money(c) { return '$' + (c / 100).toFixed(c % 100 ? 2 : 0); }
  function ymd(d) { return d.toISOString().slice(0, 10); }
  function human(s) {
    var p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function renderSizes(cfg) {
    menu.innerHTML = '';
    sizes.querySelectorAll('label').forEach(function (l) { l.remove(); });
    cfg.sizes.forEach(function (s, i) {
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
    lab.querySelector('span').textContent = text;
    box.appendChild(lab);
    return inp;
  }
  function subChoice() {
    var f = new FormData(subForm);
    return { sizeId: f.get('sizeId'), cadenceId: f.get('cadenceId'), weekday: f.get('weekday') };
  }
  function renderSubPrice() {
    if (!subCfg) return;
    var c = subChoice();
    var cell = null, i;
    for (i = 0; i < subCfg.cells.length; i++) if (subCfg.cells[i].sizeId === c.sizeId && subCfg.cells[i].cadenceId === c.cadenceId) cell = subCfg.cells[i];
    var size = null, cad = null;
    for (i = 0; i < subCfg.sizes.length; i++) if (subCfg.sizes[i].id === c.sizeId) size = subCfg.sizes[i];
    for (i = 0; i < subCfg.cadences.length; i++) if (subCfg.cadences[i].id === c.cadenceId) cad = subCfg.cadences[i];
    if (cell && size && cad) { subPrice.innerHTML = '<span></span> / month'; subPrice.querySelector('span').textContent = money(cell.priceCents); subPrice.title = size.name + ', ' + cad.name.toLowerCase(); }
    else subPrice.textContent = 'That combination is not offered.';
    subBtn.disabled = !cell;
  }
  function renderSubscription(cfg) {
    if (!subForm) return;
    subCfg = { sizes: cfg.sizes, cadences: cfg.subscriptions.cadences, cells: cfg.subscriptions.cells };
    var sizeBox = $('#sub-size'), cadBox = $('#sub-cadence'), dayBox = $('#sub-day'), note = $('#sub-day-note');
    [sizeBox, cadBox, dayBox].forEach(function (b) { b.querySelectorAll('label').forEach(function (l) { l.remove(); }); });
    cfg.sizes.forEach(function (s, i) { radio(sizeBox, 'sizeId', s.id, s.name, i === 1 || (cfg.sizes.length === 1 && i === 0)); });
    cfg.subscriptions.cadences.forEach(function (c, i) { radio(cadBox, 'cadenceId', c.id, c.name, i === 0); });
    cfg.openWeekdays.forEach(function (d, i) { var lab; radio(dayBox, 'weekday', String(d), DAYS[d], i === 0); });
    dayBox.querySelectorAll('label').forEach(function (l) { dayBox.insertBefore(l, note); });
    subForm.addEventListener('change', renderSubPrice);
    renderSubPrice();
  }
  if (subForm) subForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = new FormData(subForm), c = subChoice();
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
    return Promise.all([
      fetch('/api/config').then(function (r) { return r.json(); }),
      fetch('/api/availability?from=' + ymd(today) + '&to=' + ymd(to)).then(function (r) { return r.json(); })
    ]).then(function (res) { renderSizes(res[0]); renderDays(res[1]); renderSubscription(res[0]); })
      .catch(function () { status.textContent = 'The store is briefly unavailable. Email thebullandbloom@gmail.com to order.'; });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = new FormData(form);
    if (!f.get('date')) { status.textContent = 'Pick a day.'; return; }
    if (!form.reportValidity()) return;
    pay.disabled = true; status.textContent = 'One moment…';
    fetch('/api/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sizeId: f.get('sizeId'), date: f.get('date'), fulfillment: 'pickup',
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
