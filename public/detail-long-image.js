/* ═══════════════════════════════════════════════════════════
   detail-long-image.js — 详情长图：提交商品链接、跟踪任务进度、下载结果
   ═══════════════════════════════════════════════════════════ */
const DetailLongImage = (() => {
  let A, root, urlInput, submitBtn, list, pollTimer = null;
  let tasks = [];

  const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
  const PHASE_LABEL = {
    queued: '排队中',
    opening: '正在打开商品页',
    detecting: '正在识别详情区域',
    resolving: '正在下载图片',
    composing: '正在拼接长图',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  const ERROR_LABEL = {
    DETAIL_UNAVAILABLE: '账号未登录或登录已过期，请先在「平台账号」里登录',
    ASSET_UNAVAILABLE: '部分详情图片下载失败',
    ACCOUNT_BUSY: '该账号正在处理其它任务，请稍后再试',
    WORKER_TIMEOUT: '处理超时，请重试',
    DETAIL_SITE_UNSUPPORTED: '不支持的商品详情网站',
    DETAIL_ROOT_NOT_FOUND: '找不到可信的商品详情区域',
    DETAIL_ROOT_AMBIGUOUS: '商品详情区域不唯一',
  };

  async function call(url, opts = {}) {
    const r = A.guard(await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '操作没成功');
    return j;
  }

  function phaseText(task) {
    const base = PHASE_LABEL[task.phase] || task.phase;
    if (task.phase === 'resolving' && task.assets?.total) return `${base}（${task.assets.current}/${task.assets.total}）`;
    if (task.phase === 'composing' && Number.isFinite(task.progress)) return `${base}（${task.progress}%）`;
    if (task.phase === 'failed' && task.error) return `失败：${ERROR_LABEL[task.error.code] || task.error.message || '未知错误'}`;
    return base;
  }

  function progressPercent(task) {
    if (task.phase === 'completed') return 100;
    if (task.phase === 'composing' && Number.isFinite(task.progress)) return task.progress;
    if (task.phase === 'resolving' && task.assets?.total) return Math.round((task.assets.current / task.assets.total) * 80);
    if (task.phase === 'detecting') return 5;
    if (task.phase === 'opening') return 2;
    return 0;
  }

  function taskRow(task) {
    const row = document.createElement('div');
    row.className = 'mc-row' + (task.phase === 'completed' ? ' mc-row-ok' : task.phase === 'failed' ? ' mc-row-bad' : task.phase === 'cancelled' ? '' : ' mc-row-warn');
    row.dataset.taskId = task.id;

    const head = document.createElement('div');
    head.className = 'dli-row-head';
    const url = document.createElement('span');
    url.className = 'mc-row-name';
    url.textContent = task.url;
    const status = document.createElement('span');
    status.className = 'mc-row-status';
    status.textContent = phaseText(task);
    head.append(url, status);
    row.appendChild(head);

    if (!TERMINAL.has(task.phase)) {
      const bar = document.createElement('div');
      bar.className = 'mc-progress';
      const fill = document.createElement('div');
      fill.className = 'mc-progress-bar';
      fill.style.width = progressPercent(task) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
    }

    const acts = document.createElement('div');
    acts.className = 'pa-acts';
    if (!TERMINAL.has(task.phase)) {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ghost danger';
      cancelBtn.textContent = '取消';
      cancelBtn.onclick = async () => {
        try { await call(`/api/detail-jobs/${task.id}/cancel`, { method: 'POST' }); A.toast('已取消'); refreshList(); }
        catch (e) { A.toast(e.message, 'bad'); }
      };
      acts.appendChild(cancelBtn);
    }
    if (task.phase === 'completed') {
      const dl = document.createElement('a');
      dl.className = 'solid';
      dl.href = `/api/detail-jobs/${task.id}/download`;
      dl.textContent = '下载长图';
      acts.appendChild(dl);
    }
    if (acts.childNodes.length) row.appendChild(acts);

    return row;
  }

  function render() {
    list.replaceChildren(...tasks.map(taskRow));
  }

  async function refreshList() {
    try { ({ tasks } = await call('/api/detail-jobs')); }
    catch (e) { A.toast(e.message, 'bad'); return; }
    render();
    ensurePolling();
  }

  function ensurePolling() {
    const hasActive = tasks.some((t) => !TERMINAL.has(t.phase));
    clearInterval(pollTimer);
    pollTimer = null;
    if (!hasActive) return;
    pollTimer = setInterval(() => {
      if (A.view() !== 'detail-long-image') { clearInterval(pollTimer); pollTimer = null; return; }
      refreshList();
    }, 3000);
  }

  async function submit() {
    const url = urlInput.value.trim();
    if (!url) return A.toast('先填一个商品详情链接', 'bad');
    submitBtn.disabled = true;
    try {
      await call('/api/detail-jobs', { method: 'POST', body: JSON.stringify({ url }) });
      urlInput.value = '';
      A.toast('已提交，正在处理');
      await refreshList();
    } catch (e) { A.toast(e.message, 'bad'); }
    finally { submitBtn.disabled = false; }
  }

  function mount() {
    root = A.$('#dli-scroll');
    root.innerHTML = `
      <div class="dli-form">
        <input type="text" id="dli-url" placeholder="粘贴天猫或淘宝商品详情链接" spellcheck="false">
        <button class="solid" id="dli-submit">生成详情长图</button>
      </div>
      <p class="rail-hint">需要先在「平台账号」里登录淘宝/天猫账号，任务完成后可以在这里下载拼好的长图。</p>
      <div id="dli-list"></div>`;
    urlInput = root.querySelector('#dli-url');
    submitBtn = root.querySelector('#dli-submit');
    list = root.querySelector('#dli-list');
    submitBtn.onclick = submit;
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }

  function onShow() {
    if (!root) mount();
    return refreshList();
  }

  function onEvent(task) {
    if (!task || !task.id) return;
    const index = tasks.findIndex((t) => t.id === task.id);
    if (index === -1) tasks = [task, ...tasks];
    else tasks[index] = task;
    if (A.view() === 'detail-long-image') render();
    ensurePolling();
  }

  function init(api) { A = api; }

  return { init, onShow, onEvent };
})();
