'use strict';

const { fork } = require('node:child_process');
const path = require('node:path');

const MAX_CONCURRENT_SHARP_PROCESSES = 4;
let activeProcesses = 0;
const waiters = [];

function createSharpOperationSession(options = {}) {
  return new SharpOperationSession(options);
}

class SharpOperationSession {
  constructor({ processFactory = defaultProcessFactory, onProcessExit, onNativeStart } = {}) {
    this.processFactory = processFactory;
    this.onProcessExit = onProcessExit;
    this.onNativeStart = onNativeStart;
    this.state = 'open';
    this.busy = false;
    this.child = null;
    this.release = null;
    this.startPromise = null;
    this.exitPromise = null;
    this.stopPromise = null;
    this.closePromise = null;
    this.pending = null;
    this.nextId = 1;
    this.lifecycle = new AbortController();
    this.terminationError = null;
  }

  async run(operation, input, signal) {
    if (this.state !== 'open') throw closedError();
    if (this.busy) throw new Error('Sharp process operations must be serial');
    this.busy = true;
    try {
      await this.#start();
      if (this.state !== 'open') throw closedError();
      throwIfAborted(signal);
      const id = this.nextId++;
      return await new Promise((resolve, reject) => {
        const onAbort = () => {
          this.abort().catch(() => {});
        };
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        this.pending = { id, resolve, reject, cleanup };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        this.child.send({ id, input: Buffer.from(input), operation }, (error) => {
          if (error) this.#stop(error).catch(() => {});
        });
      }).finally(() => {
        this.pending = null;
      });
    } catch (error) {
      if (signal?.aborted) {
        await this.abort();
        throw abortError();
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }

  close() {
    return this.#closeWith(closedError());
  }

  abort() {
    return this.#closeWith(abortError());
  }

  #closeWith(error) {
    if (this.closePromise) return this.closePromise;
    this.state = 'closing';
    this.terminationError = error;
    this.lifecycle.abort();
    this.closePromise = (async () => {
      try {
        await this.startPromise?.catch(() => {});
        await this.#stop(error);
      } finally {
        this.#releaseOnce();
        this.state = 'closed';
      }
    })();
    return this.closePromise;
  }

  async #start() {
    if (this.child) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      this.release = await acquireSlot(this.lifecycle.signal);
      if (this.state !== 'open') throw closedError();
      try {
        const child = this.processFactory();
        this.child = child;
        this.exitPromise = new Promise((resolve) => {
          child.once('exit', (code, processSignal) => {
            const error = this.terminationError
              || new Error(`Sharp process exited before completing operation (code ${code}, signal ${processSignal})`);
            this.#settlePending(error);
            this.onProcessExit?.(code, processSignal);
            this.child = null;
            if (this.state === 'open') {
              this.state = 'closed';
              this.lifecycle.abort();
            }
            this.#releaseOnce();
            resolve({ code, signal: processSignal });
          });
        });
        child.on('message', (message) => this.#message(message));
        child.on('error', (error) => this.#stop(error).catch(() => {}));
      } catch (error) {
        this.#releaseOnce();
        throw error;
      }
    })();
    return this.startPromise;
  }

  #message(message) {
    if (!this.pending || message.id !== this.pending.id) return;
    if (message.type === 'native-started') {
      this.onNativeStart?.(message.id);
      return;
    }
    const pending = this.pending;
    pending.cleanup();
    if (message.type === 'result') {
      pending.resolve({ data: Buffer.from(message.data), info: message.info });
    } else if (message.type === 'failure') {
      pending.reject(Object.assign(new Error(message.error.message), message.error));
    }
  }

  #settlePending(error) {
    if (!this.pending) return;
    const pending = this.pending;
    pending.cleanup();
    pending.reject(error);
  }

  #stop(error) {
    if (this.stopPromise) return this.stopPromise;
    this.terminationError = error;
    if (!this.child) {
      this.#settlePending(error);
      return Promise.resolve();
    }
    const child = this.child;
    const exit = this.exitPromise;
    this.stopPromise = (async () => {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
      await exit;
    })();
    return this.stopPromise;
  }

  #releaseOnce() {
    const release = this.release;
    if (!release) return;
    this.release = null;
    release();
  }
}

function defaultProcessFactory() {
  return fork(path.join(__dirname, 'sharp-operation-child.js'), [], {
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
}

function acquireSlot(signal) {
  throwIfAborted(signal);
  if (activeProcesses < MAX_CONCURRENT_SHARP_PROCESSES) {
    activeProcesses += 1;
    return Promise.resolve(releaseSlot);
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal };
    const onAbort = () => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(closedError());
    };
    waiter.onAbort = onAbort;
    signal.addEventListener('abort', onAbort, { once: true });
    waiters.push(waiter);
  });
}

function releaseSlot() {
  const waiter = waiters.shift();
  if (waiter) {
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.resolve(releaseSlot);
  } else {
    activeProcesses -= 1;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  return Object.assign(new Error('The Sharp operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function closedError() {
  return Object.assign(new Error('Sharp operation session is closed'), { code: 'SHARP_SESSION_CLOSED' });
}

module.exports = { createSharpOperationSession, MAX_CONCURRENT_SHARP_PROCESSES };
