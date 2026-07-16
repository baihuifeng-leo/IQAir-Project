/* ═══════════════════════════════════════════════════════════
   login-scene.js — 登录页 3D 背景（Three.js）
   一个缓慢自转的数据核心（双层线框多面体）+ 星域粒子 + 星座连线，
   叠加 Bloom 后处理做真实发光，颜色贴合品牌色（薄荷绿 / 蓝）。
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

  /* ── 星座连线：整组做刚体旋转，粒子间相对距离不变，
     邻近关系只需在初始化时算一次，帧循环里零开销 ── */
  const linePos = [];
  const lineCol = [];
  const maxLinks = 620;
  outer:
  for (let i = 0; i < STAR_N; i++) {
    let links = 0;
    for (let j = i + 1; j < STAR_N; j++) {
      const dx = starPos[i * 3] - starPos[j * 3];
      const dy = starPos[i * 3 + 1] - starPos[j * 3 + 1];
      const dz = starPos[i * 3 + 2] - starPos[j * 3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 17 * 17) {
        linePos.push(starPos[i * 3], starPos[i * 3 + 1], starPos[i * 3 + 2], starPos[j * 3], starPos[j * 3 + 1], starPos[j * 3 + 2]);
        lineCol.push(starCol[i * 3], starCol[i * 3 + 1], starCol[i * 3 + 2], starCol[j * 3], starCol[j * 3 + 1], starCol[j * 3 + 2]);
        links++;
        if (linePos.length / 6 > maxLinks) break outer;
        if (links > 3) break;
      }
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePos), 3));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(lineCol), 3));
  const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false });
  const constellation = new THREE.LineSegments(lineGeo, lineMat);

  const field = new THREE.Group();
  field.add(stars, constellation);
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
