/* ═══════════════════════════════════════════════════════════
   preview3d-scene.js — 竞品 3D 预览的 Three.js 场景引擎（深空辉光·缎面版）

   这是全站唯一的 ES module 入口：Three.js vendor 是 ESM，而站内其余
   脚本都是经典 <script>。衔接方式：本模块把工厂挂到 window.P3DScene
   并派发 p3dscene-ready 事件，preview3d.js（经典脚本）只跟这个全局
   打交道，不直接 import。

   渲染配方是比稿定稿的（见 docs/superpowers/specs/
   2026-07-17-preview3d-deepspace-redesign.md），关键取舍：
   - 缎面哑光材质 + PMREM 柔化环境（sigma 0.35 起，小了会出硬反光条）
   - 克制光效：bloom 0.22 / 光晕 0.15 / 自发光 0.1
   - 坐标轴的量程和刻度每次 setData 现算——三个轴可以被分配任意数据
     维度（⚙ 坐标轴设置），不能像 demo 那样写死三套比例尺
   ═══════════════════════════════════════════════════════════ */
import * as THREE from './three.module.min.js';
import { OrbitControls } from './three-orbitcontrols.js';
import { EffectComposer } from './three-effectcomposer.js';
import { RenderPass } from './three-renderpass.js';
import { UnrealBloomPass } from './three-unrealbloompass.js';
import { OutputPass } from './three-outputpass.js';
import { CSS2DRenderer, CSS2DObject } from './three-css2drenderer.js';

// 世界尺寸：x/z 是水平面两个方向的全宽，y 是竖直全高
const WORLD = { x: 110, z: 90, y: 70 };

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

// 数据点装饰件的基准透明度——进入动画要从 0 渐入到这些值
const HALO_OP = 0.15, STEM_OP = 0.28, DOT_OP = 0.5;

function haloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,.85)');
  g.addColorStop(0.25, 'rgba(255,255,255,.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** 挂 CSS2D 标签；返回对象方便调用方记账（销毁时要手动摘 DOM） */
function makeLabel(text, className, parent, x, y, z) {
  const el = document.createElement('div');
  el.className = className;
  if (text instanceof Node) el.appendChild(text); else el.textContent = text;
  const o = new CSS2DObject(el);
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}

/** 把一组三维对象连同几何体/材质/CSS2D DOM 一起清掉——每次 setData 重建时用 */
function disposeGroup(group) {
  group.traverse((obj) => {
    if (obj.isCSS2DObject) obj.element.remove();
    obj.geometry?.dispose?.();
    if (obj.material) (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => {
      m.map?.dispose?.();
      m.dispose?.();
    });
  });
  group.clear();
}

function create(container) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    if (!renderer.getContext()) throw new Error('no webgl context');
  } catch {
    return null; // 调用方降级到空态提示
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#030612');

  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 2000);
  camera.position.set(96, 62, 118);

  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  Object.assign(labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
  container.appendChild(labelRenderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.autoRotateSpeed = 0.55;
  controls.target.set(0, WORLD.y * 0.42, 0);
  controls.minDistance = 40;
  controls.maxDistance = 420;

  // 自动旋转的三层状态：用户开关（wantRotate）、交互临时接管（拖动/悬停）、
  // 静置 4 秒恢复——恢复的前提永远是用户开关是开的
  let wantRotate = false;
  let idleTimer = null;
  const pauseRotate = () => { controls.autoRotate = false; clearTimeout(idleTimer); };
  const resumeSoon = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { controls.autoRotate = wantRotate; }, 4000);
  };
  controls.addEventListener('start', pauseRotate);
  controls.addEventListener('end', resumeSoon);

  /* ── 灯光（定稿配方） ── */
  scene.add(new THREE.AmbientLight(0x33415c, 0.5));
  const key = new THREE.DirectionalLight(0xdfeaff, 1.0);
  key.position.set(40, 90, 60);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x7f6ff0, 0.45);
  rim.position.set(-70, 30, -80);
  scene.add(rim);

  /* ── PMREM 程序化环境：4 块发光板拼微型影棚，sigma 0.35 把反光糊成
     柔和渐变（缎面感的关键，不许调小） ── */
  {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = new THREE.Scene();
    env.background = new THREE.Color('#05070f');
    const panel = (color, intensity, w, h, pos, rotY) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
      m.position.set(...pos);
      m.rotation.y = rotY ?? 0;
      env.add(m);
      return m;
    };
    panel('#cfe0ff', 4, 50, 22, [0, 28, -35]);
    panel('#56e6c6', 2, 32, 12, [-38, 8, 0], Math.PI / 2);
    panel('#7f6ff0', 1.6, 32, 12, [38, 4, 0], -Math.PI / 2);
    panel('#ffffff', 1.2, 70, 26, [0, -30, 30], 0).rotation.x = 0.6;
    scene.environment = pmrem.fromScene(env, 0.35).texture;
    pmrem.dispose();
    disposeGroup(env);
  }

  /* ── 星野（静态装饰，不动画） ── */
  {
    const N = 1600, pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 320 + Math.random() * 380, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) * 0.6 + 40;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8fa8d8, size: 0.9, sizeAttenuation: true, transparent: true, opacity: 0.5 })));
  }

  const HALO = haloTexture();
  const frameGroup = new THREE.Group();  // 底面网格/坐标框/轴名/刻度——随量程重建
  const pointsGroup = new THREE.Group(); // 数据点——随数据重建
  scene.add(frameGroup, pointsGroup);

  /* ── 辉光合成 ── */
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(2, 2), 0.22, 0.35, 0.68));
  composer.addPass(new OutputPass());

  /* ── 坐标框 + 轴标注（axes: {x,y,z} 每项 {name, max, ticks, fmt}；
     x=水平横向、y=水平纵深、z=竖直——跟页面 axisMap 的语义一致） ── */
  const hw = WORLD.x / 2, hd = WORLD.z / 2;
  const sx = (v, max) => -hw + (v / max) * WORLD.x;
  const sz = (v, max) => hd - (v / max) * WORLD.z;
  const sy = (v, max) => (v / max) * WORLD.y;

  function buildFrame(axes) {
    disposeGroup(frameGroup);

    const grid = new THREE.GridHelper(Math.max(WORLD.x, WORLD.z) * 1.15, 22, 0x3a5a94, 0x22355e);
    frameGroup.add(grid);

    const glowMat = new THREE.LineBasicMaterial({ color: 0x56e6c6, transparent: true, opacity: 0.95 });
    const frameMat = new THREE.LineBasicMaterial({ color: 0x2f5f8f, transparent: true, opacity: 0.9 });
    const weakMat = new THREE.LineBasicMaterial({ color: 0x1b2a4a, transparent: true, opacity: 0.6 });
    const seg = (a, b, mat) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
      frameGroup.add(new THREE.Line(g, mat));
    };
    seg([-hw, 0, hd], [hw, 0, hd], glowMat);
    seg([-hw, 0, hd], [-hw, 0, -hd], glowMat);
    seg([hw, 0, hd], [hw, 0, -hd], frameMat);
    seg([-hw, 0, -hd], [hw, 0, -hd], frameMat);
    seg([-hw, 0, hd], [-hw, WORLD.y, hd], glowMat);
    seg([-hw, WORLD.y, hd], [hw, WORLD.y, hd], weakMat);
    seg([-hw, WORLD.y, hd], [-hw, WORLD.y, -hd], weakMat);

    makeLabel(`${axes.x.name} →`, 'p3d-axis-name', frameGroup, 0, -4, hd + 8);
    makeLabel(`← ${axes.y.name}`, 'p3d-axis-name', frameGroup, -hw - 9, -4, -hd - 6);
    makeLabel(`${axes.z.name} ↑`, 'p3d-axis-name', frameGroup, -hw - 7, WORLD.y + 5, hd);
    for (const v of axes.x.ticks) makeLabel(axes.x.fmt(v), 'p3d-axis-tick', frameGroup, sx(v, axes.x.max), -3, hd + 4);
    for (const v of axes.y.ticks) makeLabel(axes.y.fmt(v), 'p3d-axis-tick', frameGroup, -hw - 4, -3, sz(v, axes.y.max));
    for (const v of axes.z.ticks) makeLabel(axes.z.fmt(v), 'p3d-axis-tick', frameGroup, -hw - 5, sy(v, axes.z.max), hd);
  }

  /* ── 数据点：缎面球 + 品牌光晕 + 落地光柱 + 产品标签 ── */
  const pickables = [];
  const pointRecs = []; // 每个点的部件引用——进入动画要逐帧操纵它们

  function buildPoints(points, axes) {
    disposeGroup(pointsGroup);
    pickables.length = 0;
    pointRecs.length = 0;

    for (const p of points) {
      const color = new THREE.Color(p.color);
      const px = sx(p.ax, axes.x.max), pz = sz(p.ay, axes.y.max), py = sy(p.az, axes.z.max);

      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(p.radius, 40, 28),
        new THREE.MeshPhysicalMaterial({
          color, emissive: color, emissiveIntensity: 0.1,
          roughness: 0.58, metalness: 0.06,
          clearcoat: 0.25, clearcoatRoughness: 0.5,
          envMapIntensity: 0.6,
          sheen: 0.4, sheenRoughness: 0.6, sheenColor: 0xffffff
        })
      );
      mesh.position.set(px, py, pz);
      mesh.userData = p;
      pointsGroup.add(mesh);
      pickables.push(mesh);

      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: HALO, color, transparent: true, opacity: 0.15,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      halo.scale.setScalar(p.radius * 3);
      halo.position.copy(mesh.position);
      pointsGroup.add(halo);

      const stemG = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(px, 0, pz), new THREE.Vector3(px, Math.max(py - p.radius, 0), pz)
      ]);
      const stem = new THREE.Line(stemG, new THREE.LineBasicMaterial({
        color, transparent: true, opacity: STEM_OP, blending: THREE.AdditiveBlending
      }));
      pointsGroup.add(stem);
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.9, 24),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: DOT_OP, blending: THREE.AdditiveBlending, depthWrite: false }));
      dot.rotation.x = -Math.PI / 2;
      dot.position.set(px, 0.05, pz);
      pointsGroup.add(dot);

      // 产品标签：品牌加粗 + 型号弱化，颜色由调用方按 YIQ 提亮后传入
      const frag = document.createDocumentFragment();
      const b = document.createElement('b');
      b.textContent = p.brand;
      const em = document.createElement('em');
      em.textContent = p.model;
      frag.append(b, em);
      const lab = makeLabel(frag, 'p3d-pt-label', mesh, 0, p.radius + 2.2, 0);
      lab.element.style.setProperty('--c', p.labelColor);

      pointRecs.push({ mesh, halo, stem, dot, labelEl: lab.element, targetY: py, brand: p.brand, fromY: 0 });
    }
  }

  /* ── 进入动画 ──
     drop：切进 tab 时的完整下落——球从坐标框上方落到各自位置，光柱随
           落点长出来，光晕/底盘/标签渐入；按品牌错峰，总时长约 1s
     pop： 场景内操作（换轴/口径/品牌筛选）重建后的短就位——只做球体
           0.28s 的缩放渐入，不重播下落（反复等 1 秒会烦）
     reduced-motion 下两种都直接就位。 */
  let anims = [];

  function settle(rec) {
    rec.mesh.position.y = rec.targetY;
    rec.mesh.scale.setScalar(1);
    rec.halo.position.y = rec.targetY;
    rec.halo.material.opacity = HALO_OP;
    rec.stem.scale.y = 1;
    rec.dot.material.opacity = DOT_OP;
    rec.labelEl.style.opacity = '';
  }

  function playEntry(kind = 'drop') {
    anims = [];
    if (!pointRecs.length) return;
    if (REDUCED) { pointRecs.forEach(settle); return; }

    if (kind === 'pop') {
      pointRecs.forEach((rec, i) => {
        settle(rec);
        rec.mesh.scale.setScalar(0.55);
        anims.push({ rec, kind, delay: i * 12, dur: 280, t0: null });
      });
      return;
    }

    const brandIdx = new Map();
    pointRecs.forEach((rec) => { if (!brandIdx.has(rec.brand)) brandIdx.set(rec.brand, brandIdx.size); });
    const per = Math.min(90, 640 / Math.max(brandIdx.size, 1));
    pointRecs.forEach((rec, i) => {
      rec.fromY = rec.targetY + WORLD.y * 0.75 + 18;
      rec.mesh.position.y = rec.fromY;
      rec.mesh.scale.setScalar(1);
      rec.halo.position.y = rec.fromY;
      rec.halo.material.opacity = 0;
      rec.stem.scale.y = 0;      // 光柱几何以地面 y=0 为原点，scale.y 就是"从地里长出来"
      rec.dot.material.opacity = 0;
      rec.labelEl.style.opacity = '0';
      anims.push({ rec, kind: 'drop', delay: brandIdx.get(rec.brand) * per + (i % 3) * 45, dur: 620, t0: null });
    });
  }

  function stepAnims(now) {
    if (!anims.length) return;
    const keep = [];
    for (const a of anims) {
      a.t0 ??= now;
      const t = (now - a.t0 - a.delay) / a.dur;
      if (t < 0) { keep.push(a); continue; }
      const k = Math.min(t, 1);
      const e = 1 - Math.pow(1 - k, 3); // easeOutCubic：快速抵达、缓缓收住，贴合缎面的克制气质
      const rec = a.rec;
      if (a.kind === 'drop') {
        rec.mesh.position.y = rec.fromY + (rec.targetY - rec.fromY) * e;
        rec.halo.position.y = rec.mesh.position.y;
        rec.halo.material.opacity = HALO_OP * e;
        rec.stem.scale.y = e;
        rec.dot.material.opacity = DOT_OP * e;
        rec.labelEl.style.opacity = String(Math.max(0, (k - 0.55) / 0.45)); // 标签等球快落定再浮现
      } else {
        rec.mesh.scale.setScalar(0.55 + 0.45 * e);
      }
      if (k < 1) keep.push(a);
      else settle(rec);
    }
    anims = keep;
  }

  /* ── 悬停 / 点击拾取 ── */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tip = document.createElement('div');
  tip.className = 'p3d-tooltip';
  tip.hidden = true;
  container.appendChild(tip);

  let hovered = null;
  let downAt = null;

  function pick(e) {
    const r = container.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return { hit: ray.intersectObjects(pickables)[0], rect: r };
  }

  renderer.domElement.addEventListener('pointermove', (e) => {
    const { hit, rect } = pick(e);
    if (hit) {
      if (hovered !== hit.object) {
        if (hovered) hovered.scale.setScalar(1);
        hovered = hit.object;
        hovered.scale.setScalar(1.22);
        tip.innerHTML = hovered.userData.tipHTML;
        tip.hidden = false;
        renderer.domElement.style.cursor = hovered.userData.url ? 'pointer' : 'default';
        pauseRotate(); // 悬停时停转，不然 tooltip 底下的球会转走
      }
      tip.style.left = Math.min(e.clientX - rect.left + 18, rect.width - 250) + 'px';
      tip.style.top = Math.min(e.clientY - rect.top + 14, rect.height - 260) + 'px';
    } else if (hovered) {
      hovered.scale.setScalar(1);
      hovered = null;
      tip.hidden = true;
      renderer.domElement.style.cursor = '';
      resumeSoon();
    }
  });
  renderer.domElement.addEventListener('pointerleave', () => {
    if (hovered) { hovered.scale.setScalar(1); hovered = null; }
    tip.hidden = true;
    renderer.domElement.style.cursor = '';
    resumeSoon();
  });

  // 点击跳转要和拖动旋转区分开：按下→抬起位移小于 6px 才算点击
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved > 6) return;
    const { hit } = pick(e);
    if (hit?.object.userData.url) window.open(hit.object.userData.url, '_blank', 'noopener');
  });

  /* ── 渲染循环：视图隐藏时停掉，不白烧 GPU ── */
  let active = true;
  function loop(time) {
    stepAnims(time);
    controls.update();
    composer.render();
    labelRenderer.render(scene, camera);
  }
  renderer.setAnimationLoop(loop);

  return {
    /** points: [{ax,ay,az,radius,brand,model,color,labelColor,url,tipHTML}]；axes: {x,y,z:{name,max,ticks,fmt}}；
        entry: 'drop'（完整下落）| 'pop'（短就位）| 省略则直接就位 */
    setData(points, axes, entry) {
      buildFrame(axes);
      buildPoints(points, axes);
      if (entry) playEntry(entry);
    },
    /** 单独重播进入动画（切回 tab 时用，不重建数据） */
    playEntry,
    setAutoRotate(v) {
      wantRotate = !!v;
      controls.autoRotate = wantRotate;
      clearTimeout(idleTimer);
    },
    resize() {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      composer.setSize(w, h);
      labelRenderer.setSize(w, h);
    },
    setActive(v) {
      if (v === active) return;
      active = v;
      renderer.setAnimationLoop(v ? loop : null);
    }
  };
}

window.P3DScene = { create };
document.dispatchEvent(new Event('p3dscene-ready'));
