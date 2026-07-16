/* ═══════════════════════════════════════════════════════════
   login-scene.js — 登录页 3D 背景（Three.js）
   一个缓慢自转的数据核心（双层线框多面体），向外辐射 5 条分支连线，
   对应产品的五大功能模块——连线是"有意义的结构"，不是随机连的星座；
   背后铺一层星域粒子做纵深，叠加 Bloom 后处理做真实发光，
   颜色贴合品牌色（薄荷绿 / 蓝）。分支节点本身不带文字，功能文字
   由页面上的悬浮玻璃卡片（.float-card）承载。
   纯装饰层：canvas 透明、铺在 body 的渐变背景之上，加载失败或
   reduced-motion 时优雅退化为已有的 CSS 渐变背景，不影响登录。
   ═══════════════════════════════════════════════════════════ */
import * as THREE from './three.module.min.js';
import { EffectComposer } from './three-effectcomposer.js';
import { RenderPass } from './three-renderpass.js';
import { UnrealBloomPass } from './three-unrealbloompass.js';
import { OutputPass } from './three-outputpass.js';

(function () {
  const canvas = document.getElementById('bg-webgl');
  if (!canvas || !window.WebGLRenderingContext) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MINT = new THREE.Color('#4ee0c1');
  const BLUE = new THREE.Color('#6b98ff');
  const WHITE = new THREE.Color('#eaf6ff');

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  } catch {
    return; // 拿不到 WebGL 上下文就直接放弃，退化成纯 CSS 背景
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 1, 400);
  camera.position.set(0, 0, 92);

  /* ── 星域粒子：一个圆点纹理 + 加色混合，越靠近核心越密 ── */
  function dotTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }
  const sprite = dotTexture();

  const STAR_N = 620;
  const starPos = new Float32Array(STAR_N * 3);
  const starCol = new Float32Array(STAR_N * 3);
  const starSize = new Float32Array(STAR_N);
  for (let i = 0; i < STAR_N; i++) {
    const r = 26 + Math.pow(Math.random(), 1.6) * 110;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.sin(phi) * Math.sin(theta) * 0.62;
    const z = r * Math.cos(phi) * 0.5 - 30;
    starPos.set([x, y, z], i * 3);
    const c = Math.random() < 0.5 ? MINT : (Math.random() < 0.7 ? BLUE : WHITE);
    const dim = 0.5 + Math.random() * 0.5;
    starCol.set([c.r * dim, c.g * dim, c.b * dim], i * 3);
    starSize[i] = Math.random() * 1.8 + 0.5;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(starSize, 1));
  const starMat = new THREE.PointsMaterial({
    size: 2.6, map: sprite, vertexColors: true, transparent: true, opacity: 0.85,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
  });
  const stars = new THREE.Points(starGeo, starMat);

  const field = new THREE.Group();
  field.add(stars);
  field.rotation.set(0.18, 0.4, 0);
  scene.add(field);

  /* ── 数据核心：双层线框多面体 + 内部柔光，转速不同产生错位感 ── */
  const core = new THREE.Group();
  core.position.set(0, 4, -6);

  const shellOuter = new THREE.Mesh(
    new THREE.IcosahedronGeometry(15, 1),
    new THREE.MeshBasicMaterial({ color: MINT, wireframe: true, transparent: true, opacity: 0.5 })
  );
  const shellInner = new THREE.Mesh(
    new THREE.IcosahedronGeometry(10, 0),
    new THREE.MeshBasicMaterial({ color: BLUE, wireframe: true, transparent: true, opacity: 0.4 })
  );
  const glowOrb = new THREE.Mesh(
    new THREE.IcosahedronGeometry(7, 1),
    new THREE.MeshBasicMaterial({ color: MINT, transparent: true, opacity: 0.09, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  core.add(shellOuter, shellInner, glowOrb);

  /* ── 5 条辐射分支：对应五大功能模块。连线本身不带文字——
     那五个模块名由 login.html 里的悬浮玻璃卡片承载，这里只负责
     "核心向外辐射出结构"的视觉——是真实产品信息架构的抽象，
     不是随手连的星座线。 ── */
  const BRANCH_N = 5;
  const branches = new THREE.Group();
  const branchLinePos = [];
  const branchLineCol = [];
  for (let i = 0; i < BRANCH_N; i++) {
    const angle = (i / BRANCH_N) * Math.PI * 2 + 0.3;
    const radius = 30 + (i % 2) * 9;
    const bx = Math.cos(angle) * radius;
    const by = Math.sin(angle) * radius * 0.5 + 3;
    const bz = ((i % 3) - 1) * 9;
    const bc = i % 2 === 0 ? MINT : BLUE;

    branchLinePos.push(0, 0, 0, bx, by, bz);
    branchLineCol.push(MINT.r, MINT.g, MINT.b, bc.r, bc.g, bc.b);

    const node = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.3, 0),
      new THREE.MeshBasicMaterial({ color: bc, transparent: true, opacity: 0.92 })
    );
    node.position.set(bx, by, bz);
    const nodeGlow = new THREE.Mesh(
      new THREE.IcosahedronGeometry(3.8, 1),
      new THREE.MeshBasicMaterial({ color: bc, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    nodeGlow.position.copy(node.position);
    branches.add(node, nodeGlow);

    // 分支外侧的细碎子节点：纯纹理装饰，呼应参考视频里节点继续分叉的质感
    for (let k = 0; k < 4; k++) {
      const t = 1.15 + Math.random() * 0.55;
      const jitter = () => (Math.random() - 0.5) * 6;
      const dot = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.35, 0),
        new THREE.MeshBasicMaterial({ color: bc, transparent: true, opacity: 0.4 })
      );
      dot.position.set(bx * t + jitter(), by * t + jitter(), bz * t + jitter());
      branches.add(dot);
    }
  }
  const branchLineGeo = new THREE.BufferGeometry();
  branchLineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(branchLinePos), 3));
  branchLineGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(branchLineCol), 3));
  const branchLineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false });
  const branchLines = new THREE.LineSegments(branchLineGeo, branchLineMat);

  core.add(branchLines, branches);
  scene.add(core);

  /* ── Bloom：真实发光，替代之前 CSS 模糊圆斑的"糊色块"效果 ── */
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.85, 0.55, 0.18);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  function resize() {
    const w = innerWidth, h = innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    bloom.setSize?.(w, h);
  }
  resize();
  addEventListener('resize', resize);

  /* ── 指针视差：轻微跟随，登录表单是主角，幅度克制 ── */
  let px = 0, py = 0, tx = 0, ty = 0;
  addEventListener('pointermove', (e) => {
    tx = (e.clientX / innerWidth - 0.5) * 2;
    ty = (e.clientY / innerHeight - 0.5) * 2;
  });

  let raf = null, running = true;
  const clock = new THREE.Clock();

  function frame() {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    const speed = reduceMotion ? 0.06 : 1;

    field.rotation.y += dt * 0.045 * speed;
    core.rotation.y += dt * 0.12 * speed;
    core.rotation.x += dt * 0.05 * speed;
    shellInner.rotation.y -= dt * 0.22 * speed;
    shellInner.rotation.x += dt * 0.09 * speed;

    px += (tx - px) * 0.04;
    py += (ty - py) * 0.04;
    camera.position.x = px * 6;
    camera.position.y = -py * 4;
    camera.lookAt(0, 0, -10);

    composer.render();
  }

  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running && !raf) frame();
    else if (!running && raf) { cancelAnimationFrame(raf); raf = null; }
  });

  frame();
})();
