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
