'use strict';

const { spawn } = require('child_process');
const path = require('path');

const DEFAULT_PYTHON = path.join(__dirname, 'venv', 'bin', 'python3');
const WORKER_SCRIPT = path.join(__dirname, 'materialcheck-paddleocr-worker.py');

// 低于这个置信度的单行识别结果当噪声丢弃（图标被认成的乱码基本都在 0.6 以下，
// 真实文案基本都在 0.85 以上，见设计讨论里的实测数据）。
const PER_LINE_MIN_CONFIDENCE = 0.5;

/**
 * PaddleOCR 加载模型要 1-30 秒，不能每张图现起一个进程（那样每张图都要重付一次
 * 模型加载的时间），所以用一个常驻的 Python 子进程，通过 stdin/stdout 按行传
 * JSON 通信，一个连接只加载一次模型。见 materialcheck-paddleocr-worker.py 顶部注释。
 */
class PaddleOcrWorker {
  constructor({ pythonBin = DEFAULT_PYTHON, script = WORKER_SCRIPT, spawnFn = spawn } = {}) {
    this.pythonBin = pythonBin;
    this.script = script;
    this.spawnFn = spawnFn;
    this.proc = null;
    this.readyPromise = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
  }

  start() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      let settled = false;
      const proc = this.spawnFn(this.pythonBin, [this.script]);
      this.proc = proc;

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => this._onData(chunk, () => {
        if (!settled) { settled = true; resolve(); }
      }));

      proc.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
      });

      proc.on('exit', (code) => {
        const err = new Error(`PaddleOCR 子进程退出了（code=${code}）`);
        for (const waiter of this.pending.values()) waiter.reject(err);
        this.pending.clear();
        this.proc = null;
        this.readyPromise = null;
        if (!settled) { settled = true; reject(err); }
      });
    });
    return this.readyPromise;
  }

  _onData(chunk, onReady) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { onReady(); continue; }
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.lines);
      else waiter.reject(new Error('OCR 识别失败：' + msg.error));
    }
  }

  async recognize(imagePath) {
    await this.start();
    if (!this.proc) throw new Error('PaddleOCR 子进程不可用');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, path: imagePath }) + '\n');
    });
  }
}

let sharedWorker = null;

/**
 * 识别图片文字，返回 { text, confidence }：
 * text 是过滤掉低置信度噪声行之后拼起来的文字，confidence 是保留下来那些行的
 * 平均置信度（一行都没保留就是 0）——调用方（materialcheck-store.js）拿这个
 * 整体置信度去判断要不要转人工核对，跟"文件名/OCR 都判断不出产品"走同一套
 * 待人工选择的流程。
 * worker 可注入桩对象用于测试（只要有 recognize(path) 方法即可）。
 */
async function runOcr(imagePath, { worker } = {}) {
  if (!worker) {
    if (!sharedWorker) sharedWorker = new PaddleOcrWorker();
    worker = sharedWorker;
  }
  const lines = await worker.recognize(imagePath);
  const kept = lines.filter((l) => l.score >= PER_LINE_MIN_CONFIDENCE);
  const text = kept.map((l) => l.text).join('\n');
  const confidence = kept.length ? kept.reduce((sum, l) => sum + l.score, 0) / kept.length : 0;
  return { text, confidence };
}

/**
 * 服务启动时探测 PaddleOCR 常驻进程能不能起得来（等它打出 ready 信号），
 * 起不来只打日志警告，不阻断服务启动——跟原来 tesseract 的探测行为一致。
 */
async function checkAvailable({ worker } = {}) {
  try {
    if (!worker) {
      if (!sharedWorker) sharedWorker = new PaddleOcrWorker();
      worker = sharedWorker;
    }
    await worker.start();
    return true;
  } catch (e) {
    console.warn('[materialcheck] PaddleOCR 常驻进程起不来，素材检测功能会失败：' + e.message);
    console.warn('[materialcheck] 跑一遍 install.sh，或确认 venv/ 目录下装好了 paddlepaddle + paddleocr');
    return false;
  }
}

module.exports = { runOcr, checkAvailable, PaddleOcrWorker, PER_LINE_MIN_CONFIDENCE };
