'use strict';
// 静态契约锁：install.sh / workbench.service 是运维脚本，不适合在测试里真的
// sudo 跑一遍 apt-get；这里锁住 Task 10 要求的几个关键点，不启动真实安装流程。
const assert = require('assert');
const fs = require('fs');
const install = fs.readFileSync('install.sh', 'utf8');
const service = fs.readFileSync('workbench.service', 'utf8');

// 新增的运行时 .js 文件都要进复制清单
const NEW_RUNTIME_FILES = [
  'detail-task-store.js', 'detail-worker.js', 'detail-worker-client.js', 'detail-url.js',
  'detail-image-resolver.js', 'detail-png-composer.js', 'detail-job-runner.js', 'detail-api.js',
  'png-stream-writer.js', 'sharp-operation-runner.js', 'sharp-operation-child.js',
  'platform-session-store.js', 'taobao-session.js', 'taobao-detail-adapter.js',
];
for (const file of NEW_RUNTIME_FILES) {
  assert.match(install, new RegExp(`\\b${file.replace('.', '\\.')}\\b`), `install.sh 缺少 ${file}`);
}

// package.json / lock 文件要拷贝，且用 npm ci --omit=dev（不装测试专用的 jsdom）
assert.match(install, /install -m 0644 "\$SRC_DIR\/package\.json"/);
assert.match(install, /install -m 0644 "\$SRC_DIR\/package-lock\.json"/);
assert.match(install, /npm ci --omit=dev/);

// Playwright Chromium + 系统依赖 + 中文字体
assert.match(install, /playwright install --with-deps chromium/);
assert.match(install, /fonts-noto-cjk/);

// 数据目录：登录会话、任务结果、浏览器缓存都要建；且都在 $DATA_DIR 唯一可写区域下，
// 跟其它历史目录一起被同一次 chown 收进 $SVC_USER，不单独开权限口子
const dataDirBlock = install.slice(install.indexOf('数据目录（服务唯一可写的地方）'));
assert.match(dataDirBlock, /"\$DATA_DIR\/platform-sessions"/);
assert.match(dataDirBlock, /"\$DATA_DIR\/detail-jobs"/);
assert.match(dataDirBlock, /"\$DATA_DIR\/browser-cache"/);
assert.match(dataDirBlock, /chown -R "\$SVC_USER:\$SVC_USER" "\$DATA_DIR"/);

// 重复安装不能删掉登录会话/历史任务：脚本里除了 $APP_DIR/public 之外，
// 不应该出现任何针对 $DATA_DIR 下这几个目录的 rm -rf
assert.doesNotMatch(install, /rm -rf "?\$DATA_DIR/);

// Playwright 浏览器缓存路径：install.sh 装的位置要跟 systemd 运行时读的位置一致，
// 否则服务启动时会用服务账号的权限又下一次（大概率因为没有出网权限而失败）
const installPath = install.match(/PLAYWRIGHT_BROWSERS_PATH="(\$DATA_DIR\/browser-cache)"/);
assert.ok(installPath, 'install.sh 里找不到 PLAYWRIGHT_BROWSERS_PATH 赋值');
assert.match(service, /Environment=PLAYWRIGHT_BROWSERS_PATH=\/var\/lib\/workbench\/browser-cache/);

// systemd 加固：Chromium 需要 --no-sandbox（在 taobao-session.js 里传的，不是靠放开
// systemd 加固项换来的）；这三条硬隔离必须原样保留，不能为了跑 Chromium 放松
assert.match(service, /ProtectSystem=strict/);
assert.match(service, /ProtectHome=true/);
assert.match(service, /ReadWritePaths=\/var\/lib\/workbench/);
const taobaoSession = fs.readFileSync('taobao-session.js', 'utf8');
assert.match(taobaoSession, /--no-sandbox/);
assert.match(taobaoSession, /--disable-dev-shm-usage/);

console.log('✓ install.sh / workbench.service detail-long-image contract holds');
