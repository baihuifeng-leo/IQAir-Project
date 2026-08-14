'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, readFile, readdir, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { test } = require('node:test');
const { inflateSync } = require('node:zlib');
const sharp = require('sharp');

const { composeDetailPng } = require('./detail-png-composer');
const { PngStreamWriter } = require('./png-stream-writer');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ORANGE = [230, 126, 34, 255];
const GREEN = [20, 150, 90, 255];
const TEAL = [10, 90, 100, 255];
const BLUE = [40, 90, 220, 255];
const YELLOW = [250, 210, 20, 255];

class CollectingWritable extends Writable {
  constructor(options) {
    super(options);
    this.chunks = [];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  bytes() {
    return Buffer.concat(this.chunks);
  }
}

test('PngStreamWriter writes valid bounded chunks and byte-exact incremental RGBA scanlines', async () => {
  const width = 1_000;
  const height = 40;
  const rgba = Buffer.alloc(width * height * 4);
  let state = 0x12345678;
  for (let index = 0; index < rgba.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    rgba[index] = state;
  }
  const output = new CollectingWritable({ highWaterMark: 97 });
  const writer = new PngStreamWriter(width, height, output);

  await writer.writeRows(rgba.subarray(0, width * 17 * 4));
  await writer.writeRows(rgba.subarray(width * 17 * 4));
  await writer.finish();

  const png = output.bytes();
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
  const chunks = parsePngChunks(png);
  assert.deepEqual(chunks.map(({ type }) => type), [
    'IHDR',
    ...chunks.filter(({ type }) => type === 'IDAT').map(() => 'IDAT'),
    'IEND',
  ]);
  assert.equal(chunks[0].data.readUInt32BE(0), width);
  assert.equal(chunks[0].data.readUInt32BE(4), height);
  assert.deepEqual([...chunks[0].data.subarray(8)], [8, 6, 0, 0, 0]);
  for (const chunk of chunks) {
    assert.equal(chunk.crc, crc32(Buffer.concat([Buffer.from(chunk.type), chunk.data])));
  }

  const idat = chunks.filter(({ type }) => type === 'IDAT');
  assert.ok(idat.length > 1, 'incompressible rows produce multiple IDAT chunks');
  assert.ok(idat.every(({ data }) => data.length <= 64 * 1024));
  const scanlines = inflateSync(Buffer.concat(idat.map(({ data }) => data)));
  assert.equal(scanlines.length, (width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (width * 4 + 1);
    assert.equal(scanlines[offset], 0);
    assert.deepEqual(
      scanlines.subarray(offset + 1, offset + 1 + width * 4),
      rgba.subarray(row * width * 4, (row + 1) * width * 4),
    );
  }
});

test('PngStreamWriter validates row accounting and propagates writable failures', async () => {
  const shortOutput = new CollectingWritable();
  const shortWriter = new PngStreamWriter(2, 2, shortOutput);
  await shortWriter.writeRows(Buffer.alloc(8));
  await assert.rejects(shortWriter.finish(), /expected 2 rows but received 1/i);
  shortOutput.destroy();

  const broken = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('disk full'));
    },
  });
  const brokenWriter = new PngStreamWriter(1, 1, broken);
  await assert.rejects(brokenWriter.writeRows(Buffer.from([1, 2, 3, 4])), /disk full/);

  assert.throws(() => new PngStreamWriter(0, 1, new CollectingWritable()), /width/i);
  const rowsWriter = new PngStreamWriter(2, 1, new CollectingWritable());
  await assert.rejects(rowsWriter.writeRows(Buffer.alloc(7)), /complete 8-byte rows/i);
  await assert.rejects(rowsWriter.writeRows(Buffer.alloc(16)), /more than its declared 1 rows/i);
});

test('composeDetailPng makes mixed media full width across strips and renders escaped Chinese content', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'detail-composer-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const outputPath = path.join(workDir, 'detail.png');
  const fixtures = await createComposerFixtures();
  const events = [];
  const blocks = [
    { kind: 'image', buffer: fixtures.orange, width: 750, height: 901, domIndex: 0 },
    {
      kind: 'text',
      text: '中文 <circle cx="50" cy="35" r="30" fill="#ff0000"/> & 净化器',
      domIndex: 1,
    },
    { kind: 'image', buffer: fixtures.checker, width: 790, height: 1200, domIndex: 2 },
    {
      kind: 'table',
      rows: [['型号 <script>', 'Atem & HealthPro'], ['适用面积', '30 m² "优选"']],
      domIndex: 3,
    },
    { kind: 'image', buffer: fixtures.blue, width: 1200, height: 333, domIndex: 4 },
    { kind: 'video', buffer: fixtures.animatedGif, width: 120, height: 60, domIndex: 5 },
  ];

  const result = await composeDetailPng(blocks, {
    outputPath,
    stripHeight: 512,
    sharp,
    emit: (event) => events.push(event),
  });

  const expectedHeight = 1442 + 74 + 1823 + 112 + 333 + 600;
  assert.equal(result.width, 1200);
  assert.equal(result.height, expectedHeight);
  const diskBytes = await readFile(outputPath);
  assert.equal(result.size, diskBytes.length);
  assert.equal(result.sha256, createHash('sha256').update(diskBytes).digest('hex'));
  assert.equal((await stat(outputPath)).size, result.size);
  assert.ok(events.some((event) => event.phase === 'composing' && event.stripTop === 0));
  assert.ok(events.some((event) => event.phase === 'composing' && event.writtenRows === expectedHeight));

  const decoded = await sharp(diskBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 1200);
  assert.equal(decoded.info.height, expectedHeight);

  const positions = {
    orange: { top: 0, height: 1442 },
    text: { top: 1442, height: 74 },
    checker: { top: 1516, height: 1823 },
    table: { top: 3339, height: 112 },
    blue: { top: 3451, height: 333 },
    video: { top: 3784, height: 600 },
  };
  const checkerReference = await sharp(fixtures.checker, { page: 0, pages: 1, animated: false })
    .resize(1200, 1823, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer();

  for (const y of [100, 900, 1600, 2600, 3500, 3900]) {
    const expected = expectedPixel(y, 4, positions, checkerReference);
    assertPixelNear(pixelAt(decoded.data, 1200, 0, y), expected, 2, `left edge row ${y}`);
    assertPixelNear(pixelAt(decoded.data, 1200, 1199, y), expected, 2, `right edge row ${y}`);
  }

  for (let boundary = 512; boundary < expectedHeight; boundary += 512) {
    for (const y of [boundary - 1, boundary]) {
      for (const x of [3, 600, 1196]) {
        const expected = expectedPixel(y, x, positions, checkerReference);
        assertPixelNear(pixelAt(decoded.data, 1200, x, y), expected, 3, `strip boundary ${y}, x=${x}`);
      }
    }
  }

  const textInk = countPixels(decoded.data, 1200, positions.text, ([r, g, b, a]) => (
    a > 240 && r < 130 && g < 130 && b < 130
  ));
  const tableInk = countPixels(decoded.data, 1200, positions.table, ([r, g, b, a]) => (
    a > 240 && r < 180 && g < 180 && b < 180
  ));
  assert.ok(textInk > 500, `expected readable Chinese text ink, received ${textInk} pixels`);
  assert.ok(tableInk > 3_000, `expected readable table/grid ink, received ${tableInk} pixels`);

  const videoTop = pixelAt(decoded.data, 1200, 20, positions.video.top + 100);
  assertPixelNear(videoTop, YELLOW, 3, 'GIF page 0 is used for the video poster');
  const labelBackground = pixelAt(decoded.data, 1200, 1190, expectedHeight - 10);
  assert.ok(labelBackground[0] < 130 && labelBackground[1] < 120 && labelBackground[2] < 60);
  const labelWhite = countPixels(decoded.data, 1200, { top: expectedHeight - 48, height: 48 }, ([r, g, b, a]) => (
    a > 240 && r > 235 && g > 235 && b > 235
  ));
  assert.ok(labelWhite > 100, 'video label contains visible white glyphs');

  const isInjectedRed = ([r, g, b, a]) => (
    a > 240 && r > 210 && g < 45 && b < 45
  );
  const forbiddenRed = countPixels(decoded.data, 1200, positions.text, isInjectedRed)
    + countPixels(decoded.data, 1200, positions.table, isInjectedRed);
  assert.equal(forbiddenRed, 0, 'escaped SVG-like text cannot inject red error/artwork pixels');
});

test('composeDetailPng removes every partial file on abort and output failure', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'detail-composer-cleanup-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const tall = await solidPng(120, 900, { r: 12, g: 100, b: 210, alpha: 1 });
  const outputPath = path.join(workDir, 'aborted.png');
  const controller = new AbortController();

  await assert.rejects(composeDetailPng([
    { kind: 'image', buffer: tall, width: 120, height: 900 },
  ], {
    outputPath,
    stripHeight: 128,
    signal: controller.signal,
    sharp,
    emit(event) {
      if (event.phase === 'composing' && event.writtenRows === 128) controller.abort();
    },
  }), (error) => error && error.code === 'DETAIL_CANCELLED');
  assert.deepEqual(await readdir(workDir), []);

  const missingParentPath = path.join(workDir, 'missing', 'failed.png');
  await assert.rejects(composeDetailPng([
    { kind: 'image', buffer: tall, width: 120, height: 900 },
  ], { outputPath: missingParentPath, sharp }));
  assert.deepEqual(await readdir(workDir), []);
});

async function createComposerFixtures() {
  const orange = await solidPng(750, 901, { r: ORANGE[0], g: ORANGE[1], b: ORANGE[2], alpha: 1 });
  const blue = await solidPng(1200, 333, { r: BLUE[0], g: BLUE[1], b: BLUE[2], alpha: 1 });
  const checkerRaw = Buffer.alloc(790 * 1200 * 4);
  for (let y = 0; y < 1200; y += 1) {
    for (let x = 0; x < 790; x += 1) {
      const color = x < 16 || x >= 774 || ((Math.floor(x / 48) + Math.floor(y / 48)) % 2 === 0)
        ? GREEN
        : TEAL;
      const offset = (y * 790 + x) * 4;
      checkerRaw[offset] = color[0];
      checkerRaw[offset + 1] = color[1];
      checkerRaw[offset + 2] = color[2];
      checkerRaw[offset + 3] = 255;
    }
  }
  const checker = await sharp(checkerRaw, { raw: { width: 790, height: 1200, channels: 4 } }).png().toBuffer();

  const gifRaw = Buffer.alloc(120 * 120 * 4);
  for (let index = 0; index < 120 * 60; index += 1) {
    gifRaw.set(YELLOW, index * 4);
  }
  for (let index = 120 * 60; index < 120 * 120; index += 1) {
    gifRaw.set(BLUE, index * 4);
  }
  const animatedGif = await sharp(gifRaw, {
    raw: { width: 120, height: 120, channels: 4, pageHeight: 60 },
  }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
  return { orange, checker, blue, animatedGif };
}

function solidPng(width, height, background) {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
}

function expectedPixel(y, x, positions, checkerReference) {
  if (y < positions.orange.top + positions.orange.height) return ORANGE;
  if (y >= positions.checker.top && y < positions.checker.top + positions.checker.height) {
    const localY = y - positions.checker.top;
    return pixelAt(checkerReference, 1200, x, localY);
  }
  if (y >= positions.blue.top && y < positions.blue.top + positions.blue.height) return BLUE;
  if (y >= positions.video.top && y < positions.video.top + positions.video.height - 48) return YELLOW;
  throw new Error(`No flat expected color at row ${y}`);
}

function pixelAt(buffer, width, x, y) {
  const offset = (y * width + x) * 4;
  return [...buffer.subarray(offset, offset + 4)];
}

function assertPixelNear(actual, expected, tolerance, label) {
  assert.equal(actual.length, 4, label);
  for (let channel = 0; channel < 4; channel += 1) {
    assert.ok(
      Math.abs(actual[channel] - expected[channel]) <= tolerance,
      `${label}: channel ${channel}, expected ${expected[channel]}, received ${actual[channel]}`,
    );
  }
}

function countPixels(buffer, width, region, predicate) {
  let count = 0;
  for (let y = region.top; y < region.top + region.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (predicate(pixelAt(buffer, width, x, y))) count += 1;
    }
  }
  return count;
}

function parsePngChunks(png) {
  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = png.readUInt32BE(offset + 8 + length);
    chunks.push({ type, data, crc });
    offset += 12 + length;
  }
  assert.equal(offset, png.length);
  return chunks;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
