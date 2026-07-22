#!/usr/bin/env bash
# 部署到生产 /opt/workbench (8090) 前的安全检查。
#
# 规则（用户拍板）：部署前必须在 main 分支且工作区干净，否则直接报错退出——
# 防止手滑把没验证完的东西带上生产。检查通过后自动 git pull 到最新，
# rsync 这一步保留人工确认，出错代价最高的一步留一个人来把关。
set -euo pipefail
cd "$(dirname "$0")"

BRANCH="$(git branch --show-current)"
if [ "$BRANCH" != "main" ]; then
  echo "拒绝部署：当前分支是 '$BRANCH'，不是 main" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "拒绝部署：工作区有未提交/未暂存的改动，先 commit 或清理：" >&2
  git status --short >&2
  exit 1
fi

echo "检查通过：main 分支，工作区干净。拉取最新 main..."
git pull origin main

echo
echo "即将同步以下改动到 /opt/workbench："
rsync -avn --delete \
  --exclude='.git' --exclude='data' --exclude='venv' --exclude='*.log' \
  ./ /opt/workbench/
echo
read -r -p "确认执行以上同步到生产 /opt/workbench？(y/N) " CONFIRM
if [ "$CONFIRM" != "y" ]; then
  echo "已取消"
  exit 1
fi

rsync -av --delete \
  --exclude='.git' --exclude='data' --exclude='venv' --exclude='*.log' \
  ./ /opt/workbench/

echo "已同步到 /opt/workbench。如涉及依赖/服务变更，记得手动重启 workbench.service。"
