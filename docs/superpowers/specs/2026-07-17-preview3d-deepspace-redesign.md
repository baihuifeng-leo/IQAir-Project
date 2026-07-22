# 竞品 3D 预览视觉重制 · 设计文档（深空辉光·缎面版）

- **日期**：2026-07-17
- **状态**：方向已由用户比稿拍板（三方向 demo → demo1 深空辉光，经 4 轮反馈调优定稿）
- **定位**：整站重建路线图的阶段三（3D 预览视觉专项）提前执行；阶段一成果分支 `redesign/dual-theme-shell` 挂起未合并，本项目从该分支切新分支，保持重建工作线性叠加

## 方向定稿过程（比稿记录）

三个方向 demo（同一份真实数据、同一套空间映射，只拼渲染氛围）：深空辉光 / 游戏引擎实体沙盘 / 产品级静物影棚。用户选深空辉光，随后 4 轮调优：

1. 初版辉光过强 → 光晕淹没数据本体，无法比较大小 → 降 bloom/halo/自发光
2. 降完变哑光塑料球 → 换清漆强反光材质 + 环境反射 → 有质感了但"过度、不高级"
3. **定稿配方：缎面哑光**——高级感 = 缎面 + 柔和渐变 + 深黑底 + 克制光效，不是强反光/强辉光
4. 加产品标签（品牌+型号悬于球体上方，品牌色自动提亮）→ 用户确认"就按这个效果继续"

## 渲染配方（定稿，实施照抄）

- **技术栈**：Three.js r160 本地 vendor（13 个文件，取自 `redesign/dark-theme` 分支），零外网依赖，相对路径 ESM import，无需 importmap
- **色调**：背景 `#030612`，ACESFilmic 色调映射，曝光 0.92
- **球体材质**（MeshPhysicalMaterial 缎面配方）：`roughness 0.58, metalness 0.06, clearcoat 0.25, clearcoatRoughness 0.5, sheen 0.4, sheenRoughness 0.6（白）, emissive=品牌色 ×0.1, envMapIntensity 0.6`
- **环境反射**：PMREM 程序化生成——4 块发光板（顶部冷白 ×4、侧薄荷 ×2、侧紫 ×1.6、底白 ×1.2），`pmrem.fromScene(env, 0.35)`；**sigma 必须 ≥0.35**，小了会出硬反光条（用户已否）
- **灯光**：环境光 `#33415c` 0.5 + 主平行光 `#dfeaff` 1.0 + 紫轮廓光 `#7f6ff0` 0.45
- **辉光**：UnrealBloomPass `strength 0.22, radius 0.35, threshold 0.68`（EffectComposer + RenderPass + OutputPass）
- **品牌色光晕**：径向渐变 canvas sprite，AdditiveBlending，透明度 0.15、尺寸 3r
- **装饰**：星野 Points（~1600 点）、落地光柱（AdditiveBlending 细线）+ 落点小圆盘、底面 GridHelper + 薄荷色发光边框线
- **产品标签**：CSS2D，品牌（600 加粗 12px）+ 型号（11px 82% 透明度），颜色=品牌色经 YIQ 亮度提亮（复用现有 `labelColor` 逻辑），黑色描影，悬于球体上方 `radius+2.2`
- **轴文字**：轴名 15px 加粗薄荷色，刻度 13px `#9fb0d0`，均带深色描影（用户反馈 11px/10px 太小）
- **交互手感**：OrbitControls，阻尼 0.06，自动旋转 0.55 速度、拖动打断、静置 4s 恢复；悬停球体放大 1.22 + tooltip

## 与现有页面的功能对接（8 项全保留）

改动只发生在**渲染层**：`preview3d.js` 里 ECharts 相关的 `ensureChart/buildOption` 换成场景引擎调用；其余 UI 逻辑（统计条、侧栏、弹层）原样保留。

| 功能 | 迁移方式 |
|---|---|
| ⚙ 三轴维度自由分配+文字自定义 | 保留现有 `axisMap/axisLabels`/互换逻辑/弹层 UI 不动；场景每次 `render()` 按 axisMap 现算各轴 domain（nice max）与刻度——**不再是固定的 pm/hcho/price 三套比例尺**，任何维度分到任何轴都要正确 |
| 气泡口径切换（性价比/销售额/销量） | 保留 `SIZE_MODES`；半径 = 开方比例尺映射到 [1.7, 5.1]，全屏时 ×1.5（沿用现有"全屏加大一档"逻辑） |
| 品牌勾选隐藏 | 保留 `hidden` set 与侧栏 UI；`render()` 重建场景数据点时过滤 |
| 悬停详情 | Raycaster 拾取 → 复用现有 `.p3d-tip` 系列 CSS 类的 HTML tooltip（绝对定位于 `.p3d-canvas` 内，全屏可见） |
| 点击跳商品链接 | Raycaster 点击命中 → `window.open(url)`（保留 noopener） |
| 全屏 | 保留 `.p3d-canvas` requestFullscreen 方案（坐标轴弹层已挂其下）；fullscreenchange → 场景 resize + 标签字号档位切换 |
| 自动旋转开关 | 按钮驱动 `controls.autoRotate`；**`prefers-reduced-motion: reduce` 时默认关**（仍可手动开，开关是用户显式操作不算装饰动效） |
| xlsx 导入 | 完全不动（数据层零改动：`preview3d-store.js`、`/api/products3d/*` 原样） |

## 模块加载方案（经典脚本 × ESM 的衔接）

全站脚本是经典 `<script>`，Three vendor 是 ESM。方案：

- 新文件 `preview3d-scene.js`（`<script type="module">`）：import Three vendor，实现场景引擎，完成后挂 `window.P3DScene` 并派发 `p3dscene-ready` 事件
- `preview3d.js`（经典脚本，保持现有加载顺序和 `Preview3D` 全局）：`render()` 时若 `window.P3DScene` 未就绪则等 `p3dscene-ready` 再渲染一次；WebGL 创建失败时 toast + 空态提示，不白屏
- vendor 13 个文件平铺在 public 根（与仓库压平布局一致），vendor 内部 `./three.module.min.js` 相对引用自然成立

## 主题关系与样式

- 场景观感**固定深空**，不随全局深浅主题翻转（比稿时与用户确认的原则：沉浸式内容区如视频播放器）
- `#view-preview3d` 保持 `data-theme-ready="false"`（页面外围控件仍是旧深色实现，阶段二迁移时再摘）
- 新增 CSS（标签/轴文字/tooltip 微调）全部以 `#view-preview3d` 或 `.p3d-` 前缀限定作用域，不泄漏
- `@media (prefers-reduced-motion: reduce)`：自动旋转默认关（上表）；场景内没有其他常驻动画（星野静止、bloom 是静态后处理）

## 附带清理

- `echarts-gl.min.js` 唯一使用方就是本页，重写后从 `index.html` 移除引用并从仓库/tarball 删除（`echarts.min.js` 保留，评论页在用）
- `CLAUDE.md` 与 `scripts/repack-tarball.sh` 的打包文件清单同步更新（+`preview3d-scene.js` +13 个 three vendor，−`echarts-gl.min.js`）

## 已知取舍

- **标签重叠**：密集簇（如 352 Z120 / IAM X5U 一带）标签会部分叠压，旋转视角可分辨——与现有 ECharts 版行为一致，demo 已让用户看过实际效果并拍板，不做避让算法（成本高、18 个点收益低）；若未来数据量大再议
- **SSAO**：ECharts 版开了 SSAO，Three 版不做（r160 SSAOPass 依赖的 vendor 文件不在手上，且缎面配方+轮廓光已有足够体积感）
- demo 用的 `scales.js` 固定 domain 常量不进正式版——正式版 domain 按数据现算（支持任意轴分配与未来数据变化）

## 验收标准（手工 + Playwright 无头复核）

1. 8 项功能逐一可用（上表），与 ECharts 版行为对齐
2. 视觉与定稿 demo 一致（缎面质感、克制光效、标签、轴文字大小）
3. 三轴任意互换后：位置、刻度、轴名、副标题、提示文案全部正确跟随
4. 全屏进出：尺寸正确、弹层可见、标签/气泡放大一档
5. `prefers-reduced-motion` 下自动旋转默认关
6. 浏览器 console 零报错；切 tab 往返、窗口缩放、侧栏折叠不出布局/尺寸问题
7. 其余页面（含评论页 ECharts 2D）不受 echarts-gl 移除影响
8. tarball 与松散文件字节一致（重打包后 diff 校验）
