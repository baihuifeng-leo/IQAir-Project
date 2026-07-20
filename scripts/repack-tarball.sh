#!/usr/bin/env bash
# 重新打包 competitive-workbench.tar.gz。
#
# merge.js / audit.js / merge.test.js / Dockerfile / docker-compose.yml /
# workbench.service / public/seed.json 这几个文件只存在于当前的
# tarball 里，不在仓库根目录摊平存放（见 CLAUDE.md）。所以不能直接
# cp 仓库根目录的文件去拼一个全新的包——先把当前 tarball 解出来当
# 基线，用它兜底这几个文件，再拿仓库根目录的最新文件覆盖其余部分。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f competitive-workbench.tar.gz ]; then
  echo "competitive-workbench.tar.gz 不存在，无法用它做基线" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

tar xzf competitive-workbench.tar.gz -C "$WORK"

cp server.js xlsx-lite.js reviews-nlp.js reviews-ingest.js \
   reviews-store.js preview3d-store.js report-store.js install.sh README.md \
   "$WORK/competitive-workbench/"

cp index.html login.html login-scene.js core.js matrix.js compare.js reviews.js preview3d.js \
   preview3d-scene.js report.js admin.js users.js settings.js styles.css \
   echarts.min.js html2canvas.min.js \
   three.module.min.js three-orbitcontrols.js three-effectcomposer.js \
   three-renderpass.js three-unrealbloompass.js three-outputpass.js \
   three-copyshader.js three-luminosityhighpassshader.js three-maskpass.js \
   three-pass.js three-shaderpass.js three-outputshader.js three-css2drenderer.js \
   "$WORK/competitive-workbench/public/"

# 竞品3D预览已从 ECharts-GL 迁到 Three.js，旧库从包里移除（echarts.min.js 保留，评论页在用）
rm -f "$WORK/competitive-workbench/public/echarts-gl.min.js"

tar czf competitive-workbench.tar.gz -C "$WORK" competitive-workbench
echo "已重新打包 competitive-workbench.tar.gz"
