/* Ambient snowfall: one fixed canvas behind every screen (survives re-renders).
   Three depth layers (far = small/slow/faint, near = large/fast/soft), a slow
   shared wind gust, per-flake sway, DPR-aware, paused when the page is hidden,
   and reduced to a still frame for prefers-reduced-motion. */
(function () {
  if (window.__frostSnow) return;
  window.__frostSnow = true;

  var canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:0';
  var ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;
  (document.body || document.documentElement).prepend(canvas);

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var W = 0, H = 0, dpr = 1, flakes = [], raf = 0, last = 0, t = 0;

  // depth: 0 far, 1 mid, 2 near, 3 warm glow (few, gentle)
  var LAYERS = [
    { r: [0.8, 1.4], v: [14, 24], a: [0.25, 0.45], w: 0.4, share: 0.48, warm: false },
    { r: [1.5, 2.4], v: [26, 42], a: [0.4, 0.65], w: 0.7, share: 0.32, warm: false },
    { r: [2.6, 4.0], v: [46, 70], a: [0.55, 0.85], w: 1.0, share: 0.14, warm: false },
    { r: [1.2, 2.2], v: [10, 20], a: [0.5, 0.75], w: 0.35, share: 0.06, warm: true },
  ];
  var rnd = function (a, b) { return a + Math.random() * (b - a); };

  function make(layerIdx, fromTop) {
    var L = LAYERS[layerIdx];
    return {
      l: layerIdx,
      warm: !!L.warm,
      x: rnd(0, W),
      y: fromTop ? rnd(-H * 0.2, -4) : rnd(0, H),
      r: rnd(L.r[0], L.r[1]),
      v: rnd(L.v[0], L.v[1]),
      a: rnd(L.a[0], L.a[1]),
      ph: rnd(0, Math.PI * 2),
      sw: rnd(8, 26) * L.w,
      sf: rnd(0.4, 1.2),
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var total = Math.max(28, Math.min(90, Math.round((W * H) / 11000)));
    flakes = [];
    LAYERS.forEach(function (L, i) {
      var n = Math.round(total * L.share);
      for (var k = 0; k < n; k++) flakes.push(make(i, false));
    });
  }

  function draw(dt) {
    t += dt;
    ctx.clearRect(0, 0, W, H);
    // Slow wind that swells and fades, shared by all flakes.
    var wind = Math.sin(t * 0.12) * 14 + Math.sin(t * 0.37 + 1.3) * 6;
    for (var i = 0; i < flakes.length; i++) {
      var f = flakes[i], L = LAYERS[f.l];
      f.y += f.v * dt;
      f.x += (wind * L.w + Math.sin(t * f.sf + f.ph) * f.sw * 0.35) * dt;
      if (f.y - f.r > H || f.x < -20 || f.x > W + 20) {
        var nf = make(f.l, true);
        if (f.x < -20) nf.x = W + rnd(0, 10); else if (f.x > W + 20) nf.x = -rnd(0, 10);
        flakes[i] = nf; continue;
      }
      var glowR = f.r * (f.warm ? 3.2 : (f.l === 2 ? 2.2 : 1.8));
      var g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, glowR);
      if (f.warm) {
        g.addColorStop(0, 'rgba(255,220,170,' + f.a + ')');
        g.addColorStop(0.4, 'rgba(255,190,120,' + (f.a * 0.5) + ')');
        g.addColorStop(1, 'rgba(255,160,80,0)');
      } else {
        g.addColorStop(0, 'rgba(235,246,255,' + f.a + ')');
        g.addColorStop(0.45, 'rgba(200,230,255,' + (f.a * 0.55) + ')');
        g.addColorStop(1, 'rgba(180,220,255,0)');
      }
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(f.x, f.y, glowR, 0, Math.PI * 2);
      ctx.fill();
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
