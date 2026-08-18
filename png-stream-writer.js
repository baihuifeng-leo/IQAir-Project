'use strict';

const { Zlib } = require('fflate');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const COMPRESSION_INPUT_BYTES = 32 * 1024;
const MAX_IDAT_PAYLOAD_BYTES = 64 * 1024;
const CRC32_TABLE = createCrc32Table();

class PngStreamWriter {
  constructor(width, height, writable) {
    assertDimension('width', width);
    assertDimension('height', height);
    if (!writable || typeof writable.write !== 'function' || typeof writable.end !== 'function') {
      throw new TypeError('PNG writable must be a Node writable stream');
    }

    this.width = width;
    this.height = height;
    this.writable = writable;
    this.rowByteLength = width * 4;
    this.writtenRows = 0;
    this.started = false;
    this.finished = false;
    this.outputEnded = false;
    this.outputError = null;
    this.compressionInput = new Uint8Array(COMPRESSION_INPUT_BYTES);
    this.compressionInputLength = 0;
    this.compressedParts = [];
    this.operation = Promise.resolve();
    this.onOutputError = (error) => {
      this.outputError = error instanceof Error ? error : new Error(String(error));
    };
    this.writable.on('error', this.onOutputError);
    this.compressor = new Zlib({ level: 6 }, (bytes) => {
      this.compressedParts.push(Buffer.from(bytes));
    });
  }

  writeRows(rgbaRows) {
    try {
      this.assertOpen();
      if (!Buffer.isBuffer(rgbaRows) && !(rgbaRows instanceof Uint8Array)) {
        throw new TypeError('RGBA rows must be a Buffer or Uint8Array');
      }
      if (rgbaRows.length % this.rowByteLength !== 0) {
        throw new RangeError(`RGBA data must contain complete ${this.rowByteLength}-byte rows`);
      }
      const suppliedRows = rgbaRows.length / this.rowByteLength;
      if (this.writtenRows + suppliedRows > this.height) {
        throw new RangeError(`PNG received more than its declared ${this.height} rows`);
      }
      this.writtenRows += suppliedRows;
    } catch (error) {
      return Promise.reject(error);
    }

    const input = new Uint8Array(rgbaRows.buffer, rgbaRows.byteOffset, rgbaRows.byteLength);
    this.operation = this.operation.then(async () => {
      await this.start();
      for (let offset = 0; offset < input.length; offset += this.rowByteLength) {
        await this.bufferCompressionInput(Uint8Array.of(0));
        await this.bufferCompressionInput(input.subarray(offset, offset + this.rowByteLength));
      }
    });
    return this.operation;
  }

  finish() {
    try {
      this.assertOpen();
      if (this.writtenRows !== this.height) {
        throw new Error(`PNG expected ${this.height} rows but received ${this.writtenRows}`);
      }
      this.finished = true;
    } catch (error) {
      return Promise.reject(error);
    }

    this.operation = this.operation.then(async () => {
      await this.start();
      this.compressor.push(
        this.compressionInput.subarray(0, this.compressionInputLength),
        true,
      );
      this.compressionInputLength = 0;
      await this.flushCompressedParts();
      await this.writeBuffer(pngChunk('IEND', Buffer.alloc(0)));
      await this.endWritable();
      this.outputEnded = true;
      this.writable.removeListener('error', this.onOutputError);
    });
    return this.operation;
  }

  abort(error) {
    if (this.outputEnded || this.writable.destroyed) return;
    this.finished = true;
    const reason = error instanceof Error ? error : new Error(String(error || 'PNG stream aborted'));
    this.writable.destroy(reason);
  }

  assertOpen() {
    if (this.finished) throw new Error('PNG stream is already finished');
  }

  async start() {
    if (this.started) return;
    this.started = true;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr.set([8, 6, 0, 0, 0], 8);
    await this.writeBuffer(PNG_SIGNATURE);
    await this.writeBuffer(pngChunk('IHDR', ihdr));
  }

  async bufferCompressionInput(input) {
    let offset = 0;
    while (offset < input.length) {
      const available = this.compressionInput.length - this.compressionInputLength;
      const length = Math.min(available, input.length - offset);
      this.compressionInput.set(input.subarray(offset, offset + length), this.compressionInputLength);
      this.compressionInputLength += length;
      offset += length;
      if (this.compressionInputLength === this.compressionInput.length) {
        this.compressor.push(this.compressionInput, false);
        this.compressionInputLength = 0;
        await this.flushCompressedParts();
      }
    }
  }

  async flushCompressedParts() {
    const parts = this.compressedParts;
    this.compressedParts = [];
    for (const compressed of parts) {
      for (let offset = 0; offset < compressed.length; offset += MAX_IDAT_PAYLOAD_BYTES) {
        const payload = compressed.subarray(offset, offset + MAX_IDAT_PAYLOAD_BYTES);
        await this.writeBuffer(pngChunk('IDAT', payload));
      }
    }
  }

  async writeBuffer(bytes) {
    if (this.outputError) throw this.outputError;
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.writable.removeListener('error', onError);
        this.writable.removeListener('close', onClose);
      };
      const settle = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onError = (error) => settle(error);
      const onClose = () => settle(this.outputError || new Error('PNG writable closed before completing a write'));
      this.writable.once('error', onError);
      this.writable.once('close', onClose);
      try {
        this.writable.write(bytes, (error) => settle(error || this.outputError));
      } catch (error) {
        settle(error);
      }
    });
  }

  async endWritable() {
    if (this.outputError) throw this.outputError;
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.writable.removeListener('finish', onFinish);
        this.writable.removeListener('error', onError);
      };
      const settle = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onFinish = () => settle(this.outputError);
      const onError = (error) => settle(error);
      this.writable.once('finish', onFinish);
      this.writable.once('error', onError);
      try {
        this.writable.end();
      } catch (error) {
        settle(error);
      }
    });
  }
}

function assertDimension(name, value) {
  if (!Number.isInteger(value) || value <= 0 || value > 0x7fffffff) {
    throw new RangeError(`PNG ${name} must be an integer between 1 and 2147483647`);
  }
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
    table[index] = value >>> 0;
  }
  return table;
}

module.exports = { PngStreamWriter };
