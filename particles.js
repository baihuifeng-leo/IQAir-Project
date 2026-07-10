/* ═══════════════════════════════════════════════════════════
   particles.js — 「评论风向标」进场动画
   Canvas 2D，无依赖。仅在进入本模块时触发一次，结束后自我销毁。

   为什么不用 Three.js：
     这里是 2D 屏幕空间的聚散，没有三维透视需求。
     Three 的 r128 打包 ~600KB，而这套核心逻辑不到 200 行，
     还能用 Float32Array 把 3000 个粒子压在一个连续内存块里。

   三幕：
     [0.00–0.30] 涌入  粒子从屏幕四周卷入，带涡旋噪声，像默默然的黑烟
     [0.30–0.72] 重组  每个粒子被指派到看板轮廓上的一个采样点，缓动吸附
     [0.72–1.00] 消散  轮廓亮度达峰后粒子扩散淡出，真实 DOM 同步淡入

   生命周期：
     start() → rAF 循环 → 自然结束或 destroy()
     无论哪条路径，都会 cancelAnimationFrame、移除 canvas、断开监听、
     释放 typed array。重复调用 destroy() 是安全的。
   ═══════════════════════════════════════════════════════════ */
'use strict';

const ParticleIntro = (() => {
  const DURATION = 2600;              // 总时长 ms
  const PHASE = { IN: 0.30, FORM: 0.72 };
  const MINT = [78, 224, 193];
  const BLUE = [91, 140, 255];

  /** 把文字/图形画到离屏 canvas，采样出目标点 —— 这就是"重组成看板雏形"的形状来源 */
  function sampleTargets(w, h, want) {
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const c = off.getContext('2d', { willReadFrequently: true });

    c.fillStyle = '#fff';

    // 主标题
    const fs = Math.min(w * 0.11, 140);
    c.font = `700 ${fs}px "Bahnschrift","DIN Alternate","PingFang SC",sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('评论风向标', w / 2, h * 0.42);

    // 看板雏形：三块卡片的轮廓
    const cw = Math.min(w * 0.21, 260), ch = cw * 0.42, gap = cw * 0.08;
    const total = cw * 3 + gap * 2;
    const y = h * 0.62;
    c.lineWidth = 3;
    c.strokeStyle = '#fff';
    for (let i = 0; i < 3; i++) {
      const x = (w - total) / 2 + i * (cw + gap);
      c.strokeRect(x, y, cw, ch);
      c.fillRect(x + cw * 0.08, y + ch * 0.62, cw * (0.3 + i * 0.2), 6);
    }

    const data = c.getImageData(0, 0, w, h).data;
    const pts = [];
    // 先粗采样，再按需要的密度抽稀，避免大屏上采出十万个点
    const step = Math.max(2, Math.round(Math.sqrt((w * h) / (want * 6))));
    for (let y2 = 0; y2 < h; y2 += step) {
      for (let x2 = 0; x2 < w; x2 += step) {
        if (data[(y2 * w + x2) * 4 + 3] > 128) pts.push(x2, y2);
      }
    }
    off.width = off.height = 0;         // 主动释放离屏位图
    return pts;
  }

  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  /** 廉价的伪涡旋场，代替真正的 curl noise */
  const swirl = (x, y, t) => [
    Math.sin(y * 0.006 + t * 1.7) * 0.9 + Math.cos(x * 0.004 - t) * 0.4,
    Math.cos(x * 0.006 - t * 1.3) * 0.9 + Math.sin(y * 0.004 + t) * 0.4
  ];

  function create({ onReveal, onDone } = {}) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    let canvas = document.createElement('canvas');
    canvas.className = 'particle-intro';
    Object.assign(canvas.style, {
      position: 'fixed', inset: '0', zIndex: '90', pointerEvents: 'none',
      opacity: '1', transition: 'opacity 420ms cubic-bezier(0.22,1,0.36,1)'
    });
    document.body.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    let raf = 0, t0 = 0, dead = false, revealed = false;
    let px, py, tx, ty, vx, vy, hue, seed;   // Float32Array
    let N = 0, W = 0, H = 0, dpr = 1;

    function layout() {
      dpr = Math.min(devicePixelRatio || 1, 2);
      W = innerWidth; H = innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function seedParticles() {
      const want = Math.round(Math.min(4200, Math.max(1400, (W * H) / 620)));
      const pts = sampleTargets(W, H, want);
      N = Math.min(want, pts.length / 2);

      px = new Float32Array(N); py = new Float32Array(N);
      tx = new Float32Array(N); ty = new Float32Array(N);
      vx = new Float32Array(N); vy = new Float32Array(N);
      hue = new Float32Array(N); seed = new Float32Array(N);

      for (let i = 0; i < N; i++) {
        // 目标点：从采样池里等距取，保证形状均匀
        const k = Math.floor((i * pts.length) / (N * 2)) * 2;
        tx[i] = pts[k]; ty[i] = pts[k + 1];

        // 出生点：屏幕四周之外
        const edge = Math.random();
        if (edge < 0.25) { px[i] = -40 - Math.random() * 160; py[i] = Math.random() * H; }
        else if (edge < 0.5) { px[i] = W + 40 + Math.random() * 160; py[i] = Math.random() * H; }
        else if (edge < 0.75) { px[i] = Math.random() * W; py[i] = -40 - Math.random() * 160; }
        else { px[i] = Math.random() * W; py[i] = H + 40 + Math.random() * 160; }

        vx[i] = vy[i] = 0;
        hue[i] = Math.random();
        seed[i] = Math.random() * Math.PI * 2;
      }
    }

    function frame(now) {
      if (dead) return;
      if (!t0) t0 = now;
      const p = Math.min(1, (now - t0) / DURATION);

      ctx.clearRect(0, 0, W, H);
      // 拖尾：不清空而是压暗，制造烟雾感
      ctx.fillStyle = 'rgba(8,12,20,0.30)';
      ctx.fillRect(0, 0, W, H);

      const time = (now - t0) / 1000;

      // 重组进度
      const form = p < PHASE.IN ? 0 : easeInOutQuad(Math.min(1, (p - PHASE.IN) / (PHASE.FORM - PHASE.IN)));
      // 消散进度
      const gone = p < PHASE.FORM ? 0 : easeOutCubic((p - PHASE.FORM) / (1 - PHASE.FORM));

      // 轮廓成形到 78% 时揭开真正的看板，让 DOM 淡入和粒子淡出重叠
      if (!revealed && p >= 0.78) { revealed = true; onReveal && onReveal(); canvas.style.opacity = '0'; }

      for (let i = 0; i < N; i++) {
        const [sx, sy] = swirl(px[i], py[i], time + seed[i] * 0.1);

        // 吸引力随 form 增长；消散阶段反向推开
        const ax = (tx[i] - px[i]) * 0.055 * form - sx * gone * 2.4;
        const ay = (ty[i] - py[i]) * 0.055 * form - sy * gone * 2.4;

        vx[i] = (vx[i] + ax + sx * (1 - form) * 0.55) * 0.86;
        vy[i] = (vy[i] + ay + sy * (1 - form) * 0.55) * 0.86;
        px[i] += vx[i]; py[i] += vy[i];

        const c = hue[i] > 0.62 ? BLUE : MINT;
        const twinkle = 0.55 + 0.45 * Math.sin(time * 4 + seed[i]);
        const alpha = (0.14 + form * 0.72) * (1 - gone) * twinkle;
        const r = 0.6 + form * 1.5;

        ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
        ctx.beginPath();
        ctx.arc(px[i], py[i], r, 0, 6.283185);
        ctx.fill();
      }

      if (p >= 1) return destroy();
      raf = requestAnimationFrame(frame);
    }

    /** 幂等销毁：rAF、DOM、监听、typed array 全部释放 */
    function destroy() {
      if (dead) return;
      dead = true;
      cancelAnimationFrame(raf);
      removeEventListener('resize', onResize);
      if (!revealed) { revealed = true; onReveal && onReveal(); }
      canvas.style.opacity = '0';
      setTimeout(() => {
        canvas.remove();
        canvas = null;
        px = py = tx = ty = vx = vy = hue = seed = null;   // 断引用，让 GC 回收 ~130KB
        onDone && onDone();
      }, 440);
    }

    // 动画中途改窗口尺寸：不重排粒子，直接收尾，比拧巴地重算更稳
    const onResize = () => destroy();

    function start() {
      if (reduce) { destroy(); return; }          // 尊重系统的"减少动态效果"
      layout();
      seedParticles();
      addEventListener('resize', onResize, { once: true });
      raf = requestAnimationFrame(frame);
    }

    return { start, destroy };
  }

  return { create };
})();

if (typeof module !== 'undefined') module.exports = { ParticleIntro };
