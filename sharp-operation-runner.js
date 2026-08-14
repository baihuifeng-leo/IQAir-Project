'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const MAX_CONCURRENT_SHARP_WORKERS = 4;
let activeWorkers = 0;
const waiters = [];

function createSharpOperationSession(options = {}) {
  return new SharpOperationSession(options);
}

class SharpOperationSession {
  constructor({ workerFactory = defaultWorkerFactory, onWorkerExit, onOperationStart } = {}) {
    this.workerFactory = workerFactory;
    this.onWorkerExit = onWorkerExit;
    this.onOperationStart = onOperationStart;
    this.worker = null;
    this.exitPromise = null;
    this.release = null;
    this.nextId = 1;
    this.pending = null;
    this.busy = false;
    this.closing = null;
  }

  async run(operation, input, signal) {
    if (this.busy) throw new Error('Sharp worker operations must be serial');
    this.busy = true;
    try {
      await this.#start(signal);
      throwIfAborted(signal);
      const id = this.nextId++;
      return await new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#terminate().then(() => reject(abortError()), reject);
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      this.pending = { id, resolve, reject, cleanup };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.worker.postMessage({ id, input: Buffer.from(input), operation });
      }).finally(() => {
        this.pending = null;
      });
    } finally {
      this.busy = false;
    }
  }

  async close() {
    await this.#terminate();
  }

  async #start(signal) {
    if (this.worker) return;
    this.release = await acquireSlot(signal);
    try {
      throwIfAborted(signal);
      const worker = this.workerFactory();
      this.worker = worker;
      this.exitPromise = new Promise((resolve) => {
        worker.once('exit', (code) => {
          if (this.pending && !this.closing) {
            const pending = this.pending;
            pending.cleanup();
            pending.reject(new Error(`Sharp worker exited before completing operation (code ${code})`));
          }
          this.onWorkerExit?.(code);
          this.release?.();
          this.release = null;
          this.worker = null;
          resolve(code);
        });
      });
      worker.on('message', (message) => this.#message(message));
      worker.on('error', (error) => this.#fail(error));
    } catch (error) {
      this.release?.();
      this.release = null;
      throw error;
    }
  }

  #message(message) {
    if (!this.pending || message.id !== this.pending.id) return;
    if (message.type === 'started') {
      this.onOperationStart?.(message.id);
      return;
    }
    const pending = this.pending;
    pending.cleanup();
    if (message.type === 'result') {
      pending.resolve({ data: Buffer.from(message.data), info: message.info });
    } else if (message.type === 'failure') {
      const error = Object.assign(new Error(message.error.message), message.error);
      pending.reject(error);
    }
  }

  #fail(error) {
    if (!this.pending) return;
    this.pending.cleanup();
    this.pending.reject(error);
  }

  async #terminate() {
    if (this.closing) return this.closing;
    if (!this.worker) {
      this.release?.();
      this.release = null;
      return;
    }
    const worker = this.worker;
    const exit = this.exitPromise;
    this.closing = (async () => {
      try {
        await worker.terminate();
        await exit;
      } finally {
        this.closing = null;
      }
    })();
    return this.closing;
  }
}

function defaultWorkerFactory() {
  return new Worker(path.join(__dirname, 'sharp-operation-worker.js'));
}

function acquireSlot(signal) {
  throwIfAborted(signal);
  if (activeWorkers < MAX_CONCURRENT_SHARP_WORKERS) {
    activeWorkers += 1;
    return Promise.resolve(releaseSlot);
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal };
    const onAbort = () => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(abortError());
    };
    waiter.onAbort = onAbort;
    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.push(waiter);
  });
}

function releaseSlot() {
  const waiter = waiters.shift();
  if (waiter) {
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.resolve(releaseSlot);
  } else {
    activeWorkers -= 1;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  return Object.assign(new Error('The Sharp operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

module.exports = { createSharpOperationSession, MAX_CONCURRENT_SHARP_WORKERS };
