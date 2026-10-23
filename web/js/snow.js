/* Ambient snowfall: one fixed canvas between the winter scenery and the app.
   Three depth layers of soft particles and six-armed snowflakes, a slow shared
   wind gust, per-flake sway and rotation, DPR-aware, paused when the page is
   hidden, and reduced to a still frame for prefers-reduced-motion.
   The canvas is decorative only: pointer-events are off and it sits behind the
   interface, so it can never cover text, buttons or navigation. */
(function () {
  if (window.__frostSnow) return;
  window.__frostSnow = true;

  var canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:1';
  var ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;
  (document.body || document.documentElement).prepend(canvas);

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var W = 0, H = 0, dpr = 1, flakes = [], raf = 0, last = 0, t = 0;

  /* kind: dot = round particle, flake = six-armed snowflake. */
  var LAYERS = [
    { kind: 'dot', r: [0.9, 1.7], v: [10, 18], a: [0.5, 0.75], w: 0.35, share: 0.4 },
    { kind: 'dot', r: [1.7, 2.7], v: [18, 30], a: [0.6, 0.85], w: 0.6, share: 0.22 },
    { kind: 'flake', r: [3.4, 5.4], v: [26, 44], a: [0.7, 0.9], w: 0.85, share: 0.23 },
    { kind: 'flake', r: [5.8, 8.2], v: [40, 60], a: [0.8, 1], w: 1.1, share: 0.15 },
  ];
  var rnd = function (a, b) { return a + Math.random() * (b - a); };

  function make(layerIdx, fromTop) {
    var L = LAYERS[layerIdx];
    return {
      l: layerIdx,
      kind: L.kind,
      x: rnd(0, W),
      y: fromTop ? rnd(-H * 0.2, -4) : rnd(0, H),
      r: rnd(L.r[0], L.r[1]),
      v: rnd(L.v[0], L.v[1]),
      a: rnd(L.a[0], L.a[1]),
      ph: rnd(0, Math.PI * 2),
      sw: rnd(8, 26) * L.w,
      sf: rnd(0.4, 1.2),
      rot: rnd(0, Math.PI * 2),
      vr: rnd(-0.35, 0.35),
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var total = Math.max(26, Math.min(78, Math.round((W * H) / 12000)));
    flakes = [];
    LAYERS.forEach(function (L, i) {
      var n = Math.round(total * L.share);
      for (var k = 0; k < n; k++) flakes.push(make(i, false));
    });
  }

  /* Six-armed flake: white arms over a faint blue edge. Only the largest
     depth layer gets a soft halo, which keeps the canvas cheap on phones. */
  function drawFlake(f) {
    if (f.l === LAYERS.length - 1) {
      var haloR = f.r * 2.1;
      var g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, haloR);
      g.addColorStop(0, 'rgba(196, 228, 248, ' + (f.a * 0.3) + ')');
      g.addColorStop(0.55, 'rgba(206, 234, 250, ' + (f.a * 0.14) + ')');
      g.addColorStop(1, 'rgba(214, 238, 252, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(f.x, f.y, haloR, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.rot);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (var i = 0; i < 3; i++) {
      var ang = (i * Math.PI) / 3;
      var dx = Math.cos(ang) * f.r;
      var dy = Math.sin(ang) * f.r;
      ctx.moveTo(-dx, -dy);
      ctx.lineTo(dx, dy);
    }
    // Small branch ticks at the tips.
    var br = f.r * 0.42;
    for (var j = 0; j < 6; j++) {
      var a2 = (j * Math.PI) / 3;
      var tx = Math.cos(a2) * f.r;
      var ty = Math.sin(a2) * f.r;
      var b1 = a2 + Math.PI / 2.6;
      var b2 = a2 - Math.PI / 2.6;
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + Math.cos(b1) * br, ty + Math.sin(b1) * br);
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + Math.cos(b2) * br, ty + Math.sin(b2) * br);
    }
    // Cool edge first, then the bright white flake on top.
    ctx.lineWidth = Math.max(1.4, f.r * 0.34);
    ctx.strokeStyle = 'rgba(152, 197, 229, ' + (f.a * 0.4) + ')';
    ctx.stroke();
    ctx.lineWidth = Math.max(0.8, f.r * 0.2);
    ctx.strokeStyle = 'rgba(255, 255, 255, ' + f.a + ')';
    ctx.stroke();
    ctx.restore();
  }

  function drawDot(f) {
    var glowR = f.r * (f.l === 1 ? 2.2 : 1.8);
    var g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, glowR);
    g.addColorStop(0, 'rgba(255, 255, 255, ' + f.a + ')');
    g.addColorStop(0.45, 'rgba(232, 246, 255, ' + (f.a * 0.65) + ')');
    g.addColorStop(1, 'rgba(180, 218, 243, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(f.x, f.y, glowR, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw(dt) {
    t += dt;
    ctx.clearRect(0, 0, W, H);
    // Slow wind that swells and fades, shared by all flakes.
    var wind = Math.sin(t * 0.12) * 12 + Math.sin(t * 0.37 + 1.3) * 5;
    for (var i = 0; i < flakes.length; i++) {
      var f = flakes[i], L = LAYERS[f.l];
      f.y += f.v * dt;
      f.x += (wind * L.w + Math.sin(t * f.sf + f.ph) * f.sw * 0.35) * dt;
      f.rot += f.vr * dt;
      if (f.y - f.r > H || f.x < -20 || f.x > W + 20) {
        var nf = make(f.l, true);
        if (f.x < -20) nf.x = W + rnd(0, 10); else if (f.x > W + 20) nf.x = -rnd(0, 10);
        flakes[i] = nf; continue;
      }
      if (f.kind === 'flake') drawFlake(f); else drawDot(f);
    }
  }

  function frame(now) {
    var dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    draw(dt);
    raf = requestAnimationFrame(frame);
  }
  function start() { if (!raf && !reduce) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  resize();
  if (reduce) draw(0); else start();
  window.addEventListener('resize', function () { resize(); if (reduce) draw(0); });
  document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });
})();
