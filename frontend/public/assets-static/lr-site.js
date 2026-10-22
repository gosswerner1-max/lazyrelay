(function () {
  window.__lrBento = true;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var MAX_TILT = 6; // degrees, kept small so the card leans, it does not flip

  // 1. Scroll entrances. Blocks that enter in the same moment are staggered 90ms apart (max 6 steps),
  //    they rise 20px and fade with the spring curve in CSS. Only translate and opacity change.
  var rv = [].slice.call(document.querySelectorAll('.rv'));
  if (reduce || !('IntersectionObserver' in window)) {
    rv.forEach(function (e) { e.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      var batch = entries.filter(function (en) { return en.isIntersecting; })
        .sort(function (a, b) { return a.boundingClientRect.top - b.boundingClientRect.top || a.boundingClientRect.left - b.boundingClientRect.left; });
      batch.forEach(function (en, k) {
        en.target.style.transitionDelay = (Math.min(k, 6) * 90) + 'ms';
        en.target.classList.add('in');
        (function (el) { setTimeout(function () { el.style.transitionDelay = ''; }, 1500); })(en.target);
        io.unobserve(en.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    rv.forEach(function (e) { io.observe(e); });
  }

  // Cursor glow, specular sheen and 3D tilt share one pointer reading, so light and lean always agree.
  if (fine && !reduce) {
    var orb = document.createElement('div');
    orb.className = 'orb';
    orb.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(orb, document.body.firstChild);
    var tx = -999, ty = -999, cx = -999, cy = -999, run = 0;
    function tick() {
      cx += (tx - cx) * 0.14; cy += (ty - cy) * 0.14;
      orb.style.transform = 'translate3d(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px,0)';
      run = (Math.abs(tx - cx) + Math.abs(ty - cy) > 0.5) ? requestAnimationFrame(tick) : 0;
    }
    window.addEventListener('pointermove', function (e) {
      tx = e.clientX; ty = e.clientY;
      if (cx === -999) { cx = tx; cy = ty; }
      if (!run) run = requestAnimationFrame(tick);
    }, { passive: true });

    [].slice.call(document.querySelectorAll('.g, .rp, .glass')).forEach(function (t) {
      var tiltable = (t.classList.contains('g') || t.classList.contains('rp')) && !t.classList.contains('notilt');
      if (!t.querySelector('.glow')) { var s = document.createElement('span'); s.className = 'glow'; s.setAttribute('aria-hidden', 'true'); t.insertBefore(s, t.firstChild); }
      var raf = 0, px = 0, py = 0, w = 1, h = 1;
      t.addEventListener('pointermove', function (e) {
        var r = t.getBoundingClientRect(); w = r.width; h = r.height;
        px = e.clientX - r.left; py = e.clientY - r.top;
        t.classList.add('lit');
        if (tiltable) t.classList.add('tilting');
        if (!raf) raf = requestAnimationFrame(function () {
          t.style.setProperty('--gx', px.toFixed(0) + 'px'); t.style.setProperty('--gy', py.toFixed(0) + 'px');
          if (tiltable) {
            // the card leans toward the cursor: top edge dips when the cursor is high, right edge dips when it is right
            var nx = px / w * 2 - 1, ny = py / h * 2 - 1;
            t.style.setProperty('--rx', (-ny * MAX_TILT).toFixed(2) + 'deg');
            t.style.setProperty('--ry', (nx * MAX_TILT).toFixed(2) + 'deg');
          }
          raf = 0;
        });
      });
      t.addEventListener('pointerleave', function () {
        t.classList.remove('lit', 'tilting');
        t.style.setProperty('--rx', '0deg'); t.style.setProperty('--ry', '0deg');
      });
    });
  }

  // Proof of Publish: auto-plays the three steps, and the toggle shows both outcomes.
  [].slice.call(document.querySelectorAll('.proof')).forEach(function (p) {
    var steps = [].slice.call(p.querySelectorAll('.pp-steps li')), btns = [].slice.call(p.querySelectorAll('.tog button')), timer = 0, i = 0;
    function show(n) { steps.forEach(function (s, k) { s.classList.toggle('on', k < n); }); }
    function play() {
      clearInterval(timer); i = 0; show(0);
      if (reduce) { show(3); return; }
      timer = setInterval(function () { i++; show(i); if (i >= 4) { i = 0; show(0); } }, 1100);
    }
    function set(out) {
      p.classList.toggle('is-ok', out === 'ok'); p.classList.toggle('is-bad', out === 'bad');
      btns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-out') === out)); });
      play();
    }
    btns.forEach(function (b) { b.addEventListener('click', function () { set(b.getAttribute('data-out')); }); });
    set('ok');
  });

  // 3. 27 actions waterfall: each command rises in turn and types out (stepped clip, CSS only). Panel height is fixed, nothing jumps.
  [].slice.call(document.querySelectorAll('.actions')).forEach(function (a) {
    var tabs = [].slice.call(a.querySelectorAll('.ag-tabs button')), panels = [].slice.call(a.querySelectorAll('.ag-panel'));
    panels.forEach(function (pn) {
      [].slice.call(pn.querySelectorAll('li')).forEach(function (li, k) {
        var txt = li.textContent; li.textContent = '';
        var sp = document.createElement('span'); sp.textContent = txt; sp.style.setProperty('--n', txt.length);
        li.appendChild(sp); li.style.setProperty('--i', k);
      });
    });
    function play(pn) {
      pn.classList.remove('play'); void pn.offsetWidth;
      if (!reduce) pn.classList.add('play');
    }
    tabs.forEach(function (t) {
      t.addEventListener('click', function () {
        var g = t.getAttribute('data-g'), shown = null;
        tabs.forEach(function (x) { x.setAttribute('aria-pressed', String(x === t)); });
        panels.forEach(function (pn) { var on = pn.getAttribute('data-g') === g; pn.hidden = !on; if (on) shown = pn; });
        if (shown) play(shown);
      });
    });
    // first panel cascades when the terminal scrolls into view
    if ('IntersectionObserver' in window && !reduce) {
      var once = new IntersectionObserver(function (en) {
        if (en[0].isIntersecting) { play(a.querySelector('.ag-panel:not([hidden])')); once.disconnect(); }
      }, { threshold: 0.35 });
      once.observe(a);
    }
  });
})();

// v7 layers: beam scheduling, seamless tickers, page vignette, grid layer and the live canvas background.
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Layer order (bottom to top): canvas (z0) < blueprint grid (.ambient::after, z1 inside .ambient) < vignette < content.
  var cv = document.createElement('canvas');
  cv.className = 'live-canvas'; cv.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(cv, document.body.firstChild);
  var grid = document.createElement('div');
  grid.className = 'ambient'; grid.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(grid, cv.nextSibling);
  var vig = document.createElement('div');
  vig.className = 'vig'; vig.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(vig, grid.nextSibling);

  // Beams: each tile gets its own start angle and speed, and only runs while it is on screen.
  var tiles = [].slice.call(document.querySelectorAll('.g, .rp'));
  tiles.forEach(function (t, i) {
    t.style.setProperty('--bd', (-(i * 1.7) % 9).toFixed(1) + 's');
    t.style.setProperty('--bt', (7 + (i % 4) * 1.5) + 's');
  });
  if ('IntersectionObserver' in window && !reduce) {
    var vis = new IntersectionObserver(function (es) {
      es.forEach(function (e) { e.target.classList.toggle('on-screen', e.isIntersecting); });
    }, { threshold: 0 });
    tiles.forEach(function (t) { vis.observe(t); });
  }

  // Tickers: repeat the lane's items until one set is wider than the ticker, then duplicate that set once
  // (aria-hidden), so translating by -50% loops with no seam and no gap even when a row has only a few logos.
  if (!reduce) [].slice.call(document.querySelectorAll('.tick .lane')).forEach(function (lane) {
    var kids = [].slice.call(lane.children);
    var box = lane.parentElement.getBoundingClientRect().width || 1200;
    var one = lane.scrollWidth || 1;
    var reps = Math.max(1, Math.ceil(box / one));
    function add(src) { src.forEach(function (k) { var c = k.cloneNode(true); c.setAttribute('aria-hidden', 'true'); c.setAttribute('tabindex', '-1'); lane.appendChild(c); }); }
    for (var r = 1; r < reps; r++) add(kids);
    var half = lane.scrollWidth || one * reps;
    add([].slice.call(lane.children));
    lane.style.setProperty('--tk', (half / 28).toFixed(1) + 's'); // every lane glides at the same speed, about 28 px/s
  });

  // Smooth freeze: pointing at a logo eases both lanes of that ticker to a stop in about 0.4 s, leaving eases them back to speed.
  // Time-based easing (time constant 90 ms), so it takes the same time at any frame rate.
  if (!reduce) [].slice.call(document.querySelectorAll('.tick')).forEach(function (tick) {
    var anims = [].slice.call(tick.querySelectorAll('.lane')).map(function (l) { return l.getAnimations()[0]; }).filter(Boolean);
    var tile = tick.closest('.g'), cap = tile && tile.querySelector('.tk-cap'), capDefault = cap ? cap.innerHTML : '';
    var rate = 1, target = 1, run = 0, lastT = 0;
    function step(now) {
      var dt = Math.min(0.05, Math.max(0.001, (now - lastT) / 1000)); lastT = now;
      rate += (target - rate) * (1 - Math.exp(-dt / 0.09));
      if (Math.abs(target - rate) < 0.004) rate = target;
      anims.forEach(function (a) { a.playbackRate = rate || 0.0001; });
      run = rate === target ? 0 : requestAnimationFrame(step);
    }
    function go(t) { target = t; if (!run) { lastT = performance.now(); run = requestAnimationFrame(step); } }
    function show(chip) {
      if (!cap) return;
      var d = chip && chip.getAttribute('data-d');
      cap.innerHTML = '';
      if (d) {
        var b = document.createElement('b'); b.textContent = chip.getAttribute('aria-label');
        var s = document.createElement('span'); s.className = 'cap-d'; s.textContent = d;
        cap.appendChild(b); cap.appendChild(s);
      } else cap.innerHTML = capDefault;
    }
    tick.addEventListener('pointerover', function (e) { var c = e.target.closest && e.target.closest('.ic'); if (c) { go(0); show(c); } });
    tick.addEventListener('pointerout', function (e) { var c = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.ic'); if (!c) { go(1); show(null); } });
    tick.addEventListener('focusin', function (e) { var c = e.target.closest && e.target.closest('.ic'); go(0); show(c); });
    tick.addEventListener('focusout', function () { go(1); show(null); });
  });

  // ---- Live canvas: drifting nodes that gather toward the cursor and link up ----
  // Palette is strictly orange (#ff5630 family) and deep teal (#0d2b2a, with lighter tints of the same hue so lines read on midnight).
  var ctx = cv.getContext('2d');
  var W = 0, H = 0, dpr = 1, nodes = [], mouse = { x: -9999, y: -9999, on: false }, last = 0, raf = 0, t0 = performance.now();
  var ORANGE = '255,86,48', TEAL_DEEP = '13,43,42', TEAL_TINT = '64,176,166';
  var LINK = 130, REACH = 230, PULL = 0.095;

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var n = Math.max(28, Math.min(86, Math.round(W * H / 17000)));
    while (nodes.length < n) nodes.push(spawn());
    nodes.length = n;
  }
  function spawn() {
    var a = Math.random() * Math.PI * 2, s = 0.12 + Math.random() * 0.22;
    return { x: Math.random() * W, y: Math.random() * H, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      r: 1.5 + Math.random() * 2.1, hot: Math.random() < 0.34, ph: Math.random() * 6.28 };
  }
  function glow(x, y, rad, rgb, a) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(' + rgb + ',' + a + ')'); g.addColorStop(1, 'rgba(' + rgb + ',0)');
    ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  function frame(now) {
    var dt = Math.max(0.2, Math.min(2.5, (now - last) / 16.67 || 1)); last = now;
    var tt = (now - t0) / 1000;
    var doc = Math.max(1, document.documentElement.scrollHeight - H), p = Math.min(1, Math.max(0, window.scrollY / doc));
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    // behind-the-glass accents: deep teal and orange fields on slow sine paths, parallaxing at a fraction of scroll speed
    glow(W * (0.2 + 0.08 * Math.sin(tt / 9)), H * (0.1 + 0.07 * Math.cos(tt / 11)) - p * 260, Math.max(W, H) * 0.62, TEAL_DEEP, 0.95);
    glow(W * (0.85 + 0.06 * Math.cos(tt / 13)), H * (0.55 + 0.08 * Math.sin(tt / 8)) - p * 420, Math.max(W, H) * 0.55, TEAL_DEEP, 0.85);
    glow(W * (0.5 + 0.12 * Math.sin(tt / 15)), H * (0.0 + 0.05 * Math.sin(tt / 7)) - p * 150, Math.max(W, H) * 0.45, ORANGE, 0.13);
    glow(W * (0.12 + 0.06 * Math.cos(tt / 10)), H * (0.95 + 0.04 * Math.sin(tt / 12)) - p * 520, Math.max(W, H) * 0.4, ORANGE, 0.08);
    ctx.globalCompositeOperation = 'source-over';

    var i, j, a, b, dx, dy, d, f, al;
    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      // independent drift, gentle wander
      a.vx += Math.cos(tt * 0.4 + a.ph) * 0.0016 * dt; a.vy += Math.sin(tt * 0.33 + a.ph * 1.7) * 0.0016 * dt;
      if (mouse.on) {
        dx = mouse.x - a.x; dy = mouse.y - a.y; d = Math.sqrt(dx * dx + dy * dy);
        if (d < REACH && d > 1) {
          // gather: pull in until about 70px from the cursor, push back out inside that so nodes settle into a halo, with extra drag inside reach
          f = (d > 70 ? (1 - d / REACH) * PULL : -(1 - d / 70) * PULL * 1.6) * dt;
          a.vx += dx / d * f; a.vy += dy / d * f;
          a.vx *= 0.95; a.vy *= 0.95;
        }
      }
      a.vx *= 0.985; a.vy *= 0.985;
      var sp = Math.sqrt(a.vx * a.vx + a.vy * a.vy);
      if (sp < 0.09) { a.vx *= 1.04; a.vy *= 1.04; } else if (sp > 1.4) { a.vx *= 0.9; a.vy *= 0.9; }
      a.x += a.vx * dt; a.y += a.vy * dt;
      if (a.x < -10) a.x = W + 10; else if (a.x > W + 10) a.x = -10;
      if (a.y < -10) a.y = H + 10; else if (a.y > H + 10) a.y = -10;
    }
    // node to node links
    ctx.lineWidth = 1;
    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      for (j = i + 1; j < nodes.length; j++) {
        b = nodes[j]; dx = a.x - b.x; dy = a.y - b.y;
        if (dx > LINK || dx < -LINK || dy > LINK || dy < -LINK) continue;
        d = Math.sqrt(dx * dx + dy * dy);
        if (d >= LINK) continue;
        al = (1 - d / LINK) * 0.34;
        if (mouse.on) { // links brighten near the cursor
          var mx = (a.x + b.x) / 2 - mouse.x, my = (a.y + b.y) / 2 - mouse.y, md = Math.sqrt(mx * mx + my * my);
          if (md < REACH) al += (1 - md / REACH) * 0.5;
        }
        ctx.strokeStyle = 'rgba(' + ((a.hot && b.hot) ? ORANGE : TEAL_TINT) + ',' + al.toFixed(3) + ')';
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    // cursor to node links, then the nodes themselves
    if (mouse.on) {
      for (i = 0; i < nodes.length; i++) {
        a = nodes[i]; dx = mouse.x - a.x; dy = mouse.y - a.y; d = Math.sqrt(dx * dx + dy * dy);
        if (d < REACH) {
          ctx.strokeStyle = 'rgba(' + ORANGE + ',' + ((1 - d / REACH) * 0.75).toFixed(3) + ')';
          ctx.beginPath(); ctx.moveTo(mouse.x, mouse.y); ctx.lineTo(a.x, a.y); ctx.stroke();
        }
      }
    }
    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      var pulse = 0.7 + 0.3 * Math.sin(tt * 1.3 + a.ph);
      ctx.fillStyle = 'rgba(' + (a.hot ? ORANGE : TEAL_TINT) + ',' + (0.95 * pulse).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, 6.2832); ctx.fill();
    }
    if (mouse.on) { // small reticle at the cursor, the point the field gathers around
      ctx.strokeStyle = 'rgba(' + ORANGE + ',0.55)'; ctx.beginPath(); ctx.arc(mouse.x, mouse.y, 7, 0, 6.2832); ctx.stroke();
      ctx.fillStyle = 'rgba(' + ORANGE + ',0.9)'; ctx.beginPath(); ctx.arc(mouse.x, mouse.y, 2, 0, 6.2832); ctx.fill();
    }
    raf = reduce ? 0 : requestAnimationFrame(frame);
  }

  size();
  window.addEventListener('resize', function () { size(); if (reduce) frame(performance.now()); }, { passive: true });
  window.addEventListener('pointermove', function (e) { mouse.x = e.clientX; mouse.y = e.clientY; mouse.on = true; }, { passive: true });
  document.addEventListener('pointerleave', function () { mouse.on = false; });
  window.addEventListener('blur', function () { mouse.on = false; });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
    else if (!reduce && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  });
  last = performance.now();
  if (reduce) frame(last); else raf = requestAnimationFrame(frame);
})();

(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Scroll reveal: shows each block once as it enters the view (hierarchy: reading order).
  // (scroll reveal moved to lr-bento.js, which staggers each batch of entering blocks)
  if (window.__lrBento) { /* reveal handled elsewhere */ } else {
    var rv = [].slice.call(document.querySelectorAll('.rv'));
    if (reduce || !('IntersectionObserver' in window)) {
      rv.forEach(function (e) { e.classList.add('in'); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
        });
      }, { threshold: 0.15, rootMargin: '0px 0px -6% 0px' });
      rv.forEach(function (e) { io.observe(e); });
    }
  }

  // Pointer depth: each layer drifts a different distance, so the stack reads as floating in 3D.
  // Only CSS variables that feed a transform are written, no layout is touched.
  if (!reduce && window.matchMedia('(min-width: 981px)').matches) {
    [].slice.call(document.querySelectorAll('[data-depth-root]')).forEach(function (root) {
      var layers = [].slice.call(root.querySelectorAll('[data-depth]'));
      var raf = 0, nx = 0, ny = 0;
      root.addEventListener('pointermove', function (e) {
        var r = root.getBoundingClientRect();
        nx = ((e.clientX - r.left) / r.width - 0.5) * 2;
        ny = ((e.clientY - r.top) / r.height - 0.5) * 2;
        if (!raf) raf = requestAnimationFrame(function () {
          layers.forEach(function (l) {
            var d = parseFloat(l.getAttribute('data-depth'));
            l.style.setProperty('--px', (nx * d).toFixed(1) + 'px');
            l.style.setProperty('--py', (ny * d).toFixed(1) + 'px');
          });
          raf = 0;
        });
      });
      root.addEventListener('pointerleave', function () {
        layers.forEach(function (l) { l.style.setProperty('--px', '0px'); l.style.setProperty('--py', '0px'); });
      });
    });
  }
})();

(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Copy buttons on the console code boxes.
  [].slice.call(document.querySelectorAll('.con')).forEach(function (box) {
    var btn = box.querySelector('.cp'), pre = box.querySelector('pre');
    if (!btn || !pre) return;
    btn.addEventListener('click', function () {
      var text = pre.innerText;
      function done() { btn.textContent = 'Copied'; btn.classList.add('done'); setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1600); }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    });
  });

  // Docs: the left navigation highlights the section being read.
  var side = document.querySelector('.side[data-spy]');
  if (side && 'IntersectionObserver' in window) {
    var links = [].slice.call(side.querySelectorAll('a[href^="#"]'));
    var map = {};
    links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
    var secs = Object.keys(map).map(function (id) { return document.getElementById(id); }).filter(Boolean);
    function mark(id) { links.forEach(function (a) { a.classList.toggle('on', a === map[id]); }); }
    // active section = the last heading that has scrolled above 160px from the top
    var spyRaf = 0;
    function spy() {
      var cur = secs[0];
      secs.forEach(function (s) { if (s.getBoundingClientRect().top <= 160) cur = s; });
      if (cur) mark(cur.id);
      spyRaf = 0;
    }
    window.addEventListener('scroll', function () { if (!spyRaf) spyRaf = requestAnimationFrame(spy); }, { passive: true });
    window.addEventListener('load', spy);
    links.forEach(function (a) { a.addEventListener('click', function () { mark(a.getAttribute('href').slice(1)); }); });
    if (secs[0]) mark(secs[0].id);
  }

  // Guides: left navigation filters the list by category.
  var gside = document.querySelector('.side[data-filter]');
  if (gside) {
    var btns = [].slice.call(gside.querySelectorAll('button[data-c]'));
    var items = [].slice.call(document.querySelectorAll('.gi'));
    var intros = [].slice.call(document.querySelectorAll('.gintro'));
    var heads = [].slice.call(document.querySelectorAll('.gcat'));
    btns.forEach(function (b) {
      var c = b.getAttribute('data-c');
      var n = c === 'all' ? items.length : items.filter(function (i) { return i.getAttribute('data-c') === c; }).length;
      var em = b.querySelector('em'); if (em) em.textContent = n;
    });
    function apply(c) {
      btns.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-c') === c); });
      items.forEach(function (i) { i.hidden = !(c === 'all' || i.getAttribute('data-c') === c); });
      heads.forEach(function (h) { h.hidden = !(c === 'all' || h.getAttribute('data-c') === c); });
      intros.forEach(function (h) { h.hidden = !(c === 'all' || h.getAttribute('data-c') === c); });
      var show = items.filter(function (i) { return !i.hidden; });
      if (!reduce) show.forEach(function (i, k) { i.style.animation = 'none'; void i.offsetWidth; i.style.animation = 'rise .55s var(--spring) both'; i.style.animationDelay = (Math.min(k, 8) * 40) + 'ms'; });
    }
    btns.forEach(function (b) { b.addEventListener('click', function () { apply(b.getAttribute('data-c')); }); });
    apply('all');
  }
})();

// Back to home: the old pages forced a fresh load for this link (a browser back/forward cache quirk made it a no-op on some paths).
(function () {
  window.addEventListener('pagehide', function () {});
  var back = document.getElementById('back-home-link');
  if (back) back.addEventListener('click', function (e) { e.preventDefault(); window.location.assign('/'); });
})();
