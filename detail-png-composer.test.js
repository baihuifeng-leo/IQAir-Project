'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { mkdtemp, readFile, readdir, rm, stat, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { test } = require('node:test');
const { inflateSync } = require('node:zlib');
const sharp = require('sharp');

const {
  composeDetailPng,
  MAX_INPUT_PIXELS,
  MAX_OUTPUT_WIDTH,
  MAX_STRIP_BYTES,
  MAX_TABLE_CELL_BYTES,
} = require('./detail-png-composer');
const { PngStreamWriter } = require('./png-stream-writer');
const { createSharpOperationSession, MAX_CONCURRENT_SHARP_WORKERS } = require('./sharp-operation-runner');

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
    { kind: 'video', buffer: fixtures.animatedGif, width: 2000, height: 1000, domIndex: 5 },
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

test('image widths alone select the canvas while a video-only detail safely falls back to its poster width', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'detail-composer-width-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const image = await solidPng(120, 60, { r: 10, g: 80, b: 200, alpha: 1 });
  const poster = await solidPng(200, 100, { r: 240, g: 180, b: 20, alpha: 1 });

  const mixed = await composeDetailPng([
    { kind: 'image', buffer: image, width: 1200, height: 600 },
    { kind: 'video', buffer: poster, width: 2000, height: 1000 },
  ], { outputPath: path.join(workDir, 'mixed.png'), sharp });
  assert.equal(mixed.width, 1200);
  assert.equal(mixed.height, 1200);

  const videoOnly = await composeDetailPng([
    { kind: 'video', buffer: poster, width: 320, height: 160 },
  ], { outputPath: path.join(workDir, 'video-only.png'), sharp });
  assert.equal(videoOnly.width, 320);
  assert.equal(videoOnly.height, 160);
});

test('operational limits reject unsafe output, input pixels, and caller strip allocation before Sharp', async (t) => {
  assert.equal(MAX_OUTPUT_WIDTH, 16_384);
  assert.equal(MAX_STRIP_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_INPUT_PIXELS, 100_000_000);
  const workDir = await mkdtemp(path.join(tmpdir(), 'detail-composer-limits-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const tiny = await solidPng(1, 1, { r: 1, g: 2, b: 3, alpha: 1 });
  let sharpCalls = 0;
  const countingSharp = (...args) => {
    sharpCalls += 1;
    return sharp(...args);
  };

  await assert.rejects(composeDetailPng([
    { kind: 'image', buffer: tiny, width: MAX_OUTPUT_WIDTH + 1, height: 1 },
  ], { outputPath: path.join(workDir, 'wide.png'), sharp: countingSharp }), /output width.*limit/i);
  await assert.rejects(composeDetailPng([
    { kind: 'image', buffer: tiny, width: 10_000, height: 10_001 },
  ], { outputPath: path.join(workDir, 'pixels.png'), sharp: countingSharp }), /input pixels.*limit/i);
  await assert.rejects(composeDetailPng([
    { kind: 'image', buffer: tiny, width: MAX_OUTPUT_WIDTH, height: 1 },
  ], {
    outputPath: path.join(workDir, 'strip.png'),
    stripHeight: Math.floor(MAX_STRIP_BYTES / (MAX_OUTPUT_WIDTH * 4)) + 1,
    sharp: countingSharp,
  }), /strip.*64 MiB/i);
  assert.equal(sharpCalls, 0);
  assert.deepEqual(await readdir(workDir), []);
});

test('long text and tables serialize only intersecting bounded SVG elements per strip', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'detail-composer-svg-bound-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const media = await solidPng(400, 4, { r: 20, g: 90, b: 180, alpha: 1 });
  const svgInputs = [];
  const spyingSharp = (input, options) => {
    if (Buffer.isBuffer(input) && input.subarray(0, 4).toString() === '<svg') {
      svgInputs.push(input.toString());
    }
    return sharp(input, options);
  };
  const tableRows = Array.from({ length: 48 }, (_, index) => [
    `第${index}行 <&>`,
    `${'x'.repeat(1_000)} ${index}`,
  ]);

  await composeDetailPng([
    { kind: 'image', buffer: media, width: 400, height: 4 },
    { kind: 'text', text: Array.from({ length: 48 }, (_, index) => `中文跨条带 ${index} <&>`).join('\n') },
    { kind: 'table', rows: tableRows },
  ], {
    outputPath: path.join(workDir, 'bounded.png'),
    stripHeight: 64,
    sharpOperationFactory: () => localSharpSession(spyingSharp),
  });

  assert.ok(svgInputs.length > 50);
  assert.ok(Math.max(...svgInputs.map((svg) => Buffer.byteLength(svg))) < 24 * 1024);
  for (const svg of svgInputs) {
    assert.ok((svg.match(/<text /g) || []).length <= 6, 'only intersecting text/cells are serialized');
    assert.ok((svg.match(/<clipPath /g) || []).length <= 6, 'only intersecting table cells are serialized');
  }
});

test('table cells preserve complete escaped content and reject cells over 64 KiB before temp creation', async (t) => {
  assert.equal(MAX_TABLE_CELL_BYTES, 64 * 1024);
  const workDir = await mkdtemp(path.join(tmpdir(), 'detail-composer-table-cell-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const media = await solidPng(800, 1, { r: 20, g: 90, b: 180, alpha: 1 });
  const completeCell = `${'中<&>'.repeat(90)}-末尾`;
  const svgInputs = [];

  await composeDetailPng([
    { kind: 'image', buffer: media, width: 800, height: 1 },
    { kind: 'table', rows: [[completeCell]] },
  ], {
    outputPath: path.join(workDir, 'complete.png'),
    stripHeight: 64,
    sharpOperationFactory: () => recordingRawSession(svgInputs),
  });
  const escaped = completeCell.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  assert.ok(svgInputs.some((svg) => svg.includes(escaped)), 'the complete escaped cell reaches Sharp');

  const aggregateCells = Array.from({ length: 5 }, (_, index) => `${index}-${'x'.repeat(60_000)}-end`);
  await composeDetailPng([
    { kind: 'image', buffer: media, width: 800, height: 1 },
    { kind: 'table', rows: [aggregateCells] },
  ], {
    outputPath: path.join(workDir, 'aggregate.png'),
    stripHeight: 64,
    sharpOperationFactory: () => recordingRawSession(svgInputs),
  });
  for (const cell of aggregateCells) {
    assert.ok(svgInputs.some((svg) => svg.includes(cell)), 'each valid cell is rasterized in full');
  }

  let tempCreates = 0;
  await assert.rejects(composeDetailPng([
    { kind: 'image', buffer: media, width: 800, height: 1 },
    { kind: 'table', rows: [['x'.repeat(MAX_TABLE_CELL_BYTES + 1)]] },
  ], {
    outputPath: path.join(workDir, 'too-large.png'),
    sharp,
    operations: {
      createWriteStream(...args) {
        tempCreates += 1;
        return fs.createWriteStream(...args);
      },
    },
  }), /table cell exceeds the 64 KiB operational limit/);
  assert.equal(tempCreates, 0);
  assert.deepEqual((await readdir(workDir)).filter((name) => name.includes('.part-')), []);
});

test('a Sharp worker session rejects overlapping calls without overwriting its active operation', async () => {
  const session = createSharpOperationSession();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');
  const operation = { kind: 'svg', width: 1, height: 1, limitInputPixels: MAX_INPUT_PIXELS };
  try {
    const first = session.run(operation, svg);
    await assert.rejects(session.run(operation, svg), /must be serial/);
    const result = await first;
    assert.equal(result.info.width, 1);
    assert.equal(result.info.height, 1);
    assert.equal(result.info.channels, 4);
  } finally {
    await session.close();
  }
});

test('glyphs, table borders, and the video overlay remain continuous across strip boundaries', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'detail-composer-boundaries-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const lead = await solidPng(200, 21, { r: 40, g: 90, b: 220, alpha: 1 });
  const gifRaw = Buffer.alloc(20 * 16 * 4);
  for (let index = 0; index < 20 * 8; index += 1) gifRaw.set(YELLOW, index * 4);
  for (let index = 20 * 8; index < 20 * 16; index += 1) gifRaw.set(BLUE, index * 4);
  const poster = await sharp(gifRaw, {
    raw: { width: 20, height: 16, channels: 4, pageHeight: 8 },
  }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
  const outputPath = path.join(workDir, 'boundaries.png');

  await composeDetailPng([
    { kind: 'image', buffer: lead, width: 200, height: 21 },
    { kind: 'text', text: '中文连续' },
    { kind: 'table', rows: [['型号', 'Atem'], ['面积', '30 m²']] },
    { kind: 'video', buffer: poster, width: 200, height: 80 },
  ], { outputPath, stripHeight: 64, sharp });

  const { data, info } = await sharp(outputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.height, 287);
  const darkOnRow = (y, fromX = 1, toX = 199) => {
    let count = 0;
    for (let x = fromX; x < toX; x += 1) {
      const [r, g, b] = pixelAt(data, 200, x, y);
      if (r < 150 && g < 150 && b < 150) count += 1;
    }
    return count;
  };
  assert.ok(darkOnRow(63) > 0 && darkOnRow(64) > 0, 'one Chinese glyph crosses row 64');
  assertPixelNear(pixelAt(data, 200, 100, 127), [170, 178, 189, 255], 30, 'table before row 128');
  assertPixelNear(pixelAt(data, 200, 100, 128), [170, 178, 189, 255], 30, 'table after row 128');
  for (const y of [255, 256]) {
    const [r, g, b] = pixelAt(data, 200, 190, y);
    assert.ok(r < 190 && g < 180 && b < 150, `video overlay covers boundary row ${y}: ${r},${g},${b}`);
  }
});

test('abort terminates and exits the real Sharp worker before rejection and partial-file removal', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'detail-composer-active-abort-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const tiny = await solidPng(2, 2, { r: 1, g: 2, b: 3, alpha: 1 });

  assert.equal(MAX_CONCURRENT_SHARP_WORKERS, 4);
  const sharpController = new AbortController();
  const sharpOutput = path.join(workDir, 'sharp.png');
  const order = [];
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));
  const sharpCompose = composeDetailPng([
    { kind: 'image', buffer: tiny, width: 2, height: 2 },
  ], {
    outputPath: sharpOutput,
    signal: sharpController.signal,
    sharpOperationFactory: () => createSharpOperationSession({
      onOperationStart() { sharpController.abort(); },
      onWorkerExit() { order.push('worker-exit'); },
    }),
    operations: {
      async unlink(filePath) {
        order.push('unlink');
        await fs.promises.unlink(filePath);
      },
    },
  });
  await assert.rejects(withTimeout(sharpCompose, 2_000), (error) => {
    order.push('rejected');
    return error?.code === 'DETAIL_CANCELLED';
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['worker-exit', 'unlink', 'rejected']);
  assert.deepEqual(unhandled, []);
  assert.deepEqual(await readdir(workDir), []);

  const writeController = new AbortController();
  let writeStream;
  const writeOutput = path.join(workDir, 'write.png');
  const writeCompose = composeDetailPng([
    { kind: 'image', buffer: tiny, width: 2, height: 2 },
  ], {
    outputPath: writeOutput,
    signal: writeController.signal,
    sharp,
    operations: {
      createWriteStream(filePath, options) {
        writeStream = pendingFileWriteStream(filePath, options);
        return writeStream;
      },
    },
  });
  await waitUntil(() => writeStream?.writePending());
  writeController.abort();
  await assert.rejects(withTimeout(writeCompose, 250), (error) => error?.code === 'DETAIL_CANCELLED');
  assert.equal(writeStream.destroyed, true);
  assert.deepEqual(await readdir(workDir), []);

  const endController = new AbortController();
  let endStream;
  const endOutput = path.join(workDir, 'end.png');
  const endCompose = composeDetailPng([
    { kind: 'image', buffer: tiny, width: 2, height: 2 },
  ], {
    outputPath: endOutput,
    signal: endController.signal,
    sharp,
    operations: {
      createWriteStream(filePath, options) {
        endStream = pendingFileEndStream(filePath, options);
        return endStream;
      },
    },
  });
  await waitUntil(() => endStream?.endPending());
  endController.abort();
  await assert.rejects(withTimeout(endCompose, 250), (error) => error?.code === 'DETAIL_CANCELLED');
  assert.equal(endStream.destroyed, true);
  assert.deepEqual(await readdir(workDir), []);
});

test('composer cleans real partial files on IDAT, end, and rename failures without replacing destination', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'detail-composer-atomic-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const source = await solidPng(64, 300, { r: 30, g: 130, b: 210, alpha: 1 });

  for (const fault of ['idat', 'end', 'rename']) {
    const destination = path.join(workDir, `${fault}.png`);
    const original = Buffer.from(`existing-${fault}`);
    await writeFile(destination, original);
    let stream;
    const operations = fault === 'rename'
      ? { rename: async () => { throw new Error('rename failed'); } }
      : {
          createWriteStream(filePath, options) {
            stream = faultingFileStream(filePath, options, fault);
            return stream;
          },
        };
    await assert.rejects(composeDetailPng([
      { kind: 'image', buffer: source, width: 64, height: 300 },
    ], { outputPath: destination, stripHeight: 64, sharp, operations }), new RegExp(`${fault} failed`));
    assert.deepEqual(await readFile(destination), original);
    assert.deepEqual((await readdir(workDir)).filter((name) => name.includes('.part-')), []);
    if (fault === 'idat') assert.ok(stream.idatBytes() > 0, 'an IDAT reached the real temporary file');
  }
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

function localSharpSession(sharpImplementation) {
  return {
    async run(operation, input) {
      let pipeline;
      if (operation.kind === 'media') {
        pipeline = sharpImplementation(input, {
          animated: false,
          page: 0,
          pages: 1,
          limitInputPixels: operation.limitInputPixels,
          sequentialRead: true,
        })
          .resize(operation.width, operation.height, { fit: 'fill' })
          .extract({
            left: 0,
            top: operation.top,
            width: operation.width,
            height: operation.fragmentHeight,
          })
          .ensureAlpha()
          .raw();
      } else {
        pipeline = sharpImplementation(input, { limitInputPixels: operation.limitInputPixels })
          .ensureAlpha()
          .raw();
      }
      return pipeline.toBuffer({ resolveWithObject: true });
    },
    async close() {},
  };
}

function recordingRawSession(svgInputs) {
  return {
    async run(operation, input) {
      if (operation.kind === 'svg') svgInputs.push(Buffer.from(input).toString());
      return {
        data: Buffer.alloc(operation.width * (operation.fragmentHeight || operation.height) * 4),
        info: {
          width: operation.width,
          height: operation.fragmentHeight || operation.height,
          channels: 4,
        },
      };
    },
    async close() {},
  };
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

function pendingFileWriteStream(filePath, options) {
  const stream = fs.createWriteStream(filePath, options);
  const originalWrite = stream.write.bind(stream);
  let pending = false;
  stream.write = (chunk, callback) => originalWrite(chunk, (error) => {
    if (error) callback(error);
    else pending = true;
  });
  stream.writePending = () => pending;
  return stream;
}

function pendingFileEndStream(filePath, options) {
  const stream = fs.createWriteStream(filePath, options);
  let pending = false;
  stream.end = () => {
    pending = true;
    return stream;
  };
  stream.endPending = () => pending;
  return stream;
}

function faultingFileStream(filePath, options, fault) {
  const stream = fs.createWriteStream(filePath, options);
  let writtenIdatBytes = 0;
  if (fault === 'idat') {
    const originalWrite = stream.write.bind(stream);
    stream.write = (chunk, callback) => {
      const isIdat = chunk.length >= 12 && chunk.subarray(4, 8).toString('ascii') === 'IDAT';
      return originalWrite(chunk, (error) => {
        if (error) {
          callback(error);
          return;
        }
        if (!isIdat) {
          callback();
          return;
        }
        writtenIdatBytes += chunk.length;
        const failure = new Error('idat failed');
        stream.destroy(failure);
        callback(failure);
      });
    };
  } else if (fault === 'end') {
    stream.end = () => stream.destroy(new Error('end failed'));
  }
  stream.idatBytes = () => writtenIdatBytes;
  return stream;
}

function withTimeout(promise, milliseconds) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`operation did not settle within ${milliseconds}ms`)), milliseconds);
    }),
  ]);
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
