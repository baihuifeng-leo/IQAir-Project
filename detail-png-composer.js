'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { rename, stat, unlink } = require('node:fs/promises');
const path = require('node:path');
const { PngStreamWriter } = require('./png-stream-writer');
const { createSharpOperationSession } = require('./sharp-operation-runner');

const DEFAULT_STRIP_HEIGHT = 512;
const TEXT_FONT_SIZE = 28;
const TEXT_LINE_HEIGHT = 42;
const TEXT_HORIZONTAL_PADDING = 24;
const TEXT_VERTICAL_PADDING = 16;
const TABLE_FONT_SIZE = 22;
const TABLE_ROW_HEIGHT = 56;
const VIDEO_LABEL_HEIGHT = 48;
const FONT_FAMILY = 'Noto Sans CJK SC';
const MAX_OUTPUT_WIDTH = 16_384;
const MAX_STRIP_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_PIXELS = 100_000_000;
const MAX_STRIP_HEIGHT = 4_096;
const MAX_TABLE_COLUMNS = 32;
const MAX_TABLE_CELL_BYTES = 64 * 1024;
const MAX_SVG_BYTES = 384 * 1024;
const DEFAULT_OPERATIONS = Object.freeze({ createReadStream, createWriteStream, rename, stat, unlink });

async function composeDetailPng(blocks, {
  outputPath,
  stripHeight = DEFAULT_STRIP_HEIGHT,
  signal,
  sharp,
  sharpOperationFactory = createSharpOperationSession,
  emit,
  operations,
} = {}) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new TypeError('outputPath must be a non-empty path');
  }
  if (sharp != null && typeof sharp !== 'function') throw new TypeError('sharp must be a function');
  if (typeof sharpOperationFactory !== 'function') throw new TypeError('sharpOperationFactory must be a function');
  assertPositiveInteger('stripHeight', stripHeight);
  throwIfAborted(signal);

  const layout = layoutBlocks(blocks);
  const io = resolveOperations(operations);
  const stripBytes = checkedProduct('strip RGBA bytes', layout.width, stripHeight, 4);
  if (stripHeight > MAX_STRIP_HEIGHT || stripBytes > MAX_STRIP_BYTES) {
    throw new RangeError('strip allocation exceeds the 64 MiB operational limit');
  }
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.part-${process.pid}-${randomUUID()}`,
  );
  const sharpOperations = sharpOperationFactory();
  if (!sharpOperations || typeof sharpOperations.run !== 'function' || typeof sharpOperations.close !== 'function') {
    throw new TypeError('sharpOperationFactory must return a run/close session');
  }
  const writable = io.createWriteStream(temporaryPath, { flags: 'wx' });
  const writer = new PngStreamWriter(layout.width, layout.height, writable);
  let completed = false;
  const abortOutput = () => writer.abort(cancelledError());
  signal?.addEventListener('abort', abortOutput, { once: true });
  if (signal?.aborted) abortOutput();

  try {
    for (let stripTop = 0; stripTop < layout.height; stripTop += stripHeight) {
      throwIfAborted(signal);
      const rowCount = Math.min(stripHeight, layout.height - stripTop);
      const strip = Buffer.alloc(layout.width * rowCount * 4, 255);
      try {
        for (const positioned of layout.blocks) {
          if (positioned.top >= stripTop + rowCount || positioned.top + positioned.height <= stripTop) {
            continue;
          }
          throwIfAborted(signal);
          await renderBlockIntoStrip(strip, layout.width, stripTop, rowCount, positioned, sharpOperations, signal);
        }
        throwIfAborted(signal);
        await writer.writeRows(strip);
      } finally {
        strip.fill(0);
      }
      safeEmit(emit, {
        phase: 'composing',
        stripTop,
        rowCount,
        writtenRows: stripTop + rowCount,
        totalHeight: layout.height,
        width: layout.width,
      });
    }

    throwIfAborted(signal);
    await writer.finish();
    throwIfAborted(signal);
    const fileStat = await io.stat(temporaryPath);
    const sha256 = await sha256File(temporaryPath, signal, io);
    throwIfAborted(signal);
    await io.rename(temporaryPath, outputPath);
    completed = true;
    return { width: layout.width, height: layout.height, size: fileStat.size, sha256 };
  } catch (error) {
    await sharpOperations.close();
    if (!writable.destroyed) writer.abort(error);
    await waitForClose(writable);
    throw normalizeAbort(error, signal);
  } finally {
    signal?.removeEventListener('abort', abortOutput);
    await sharpOperations.close();
    if (!completed) await removeFile(temporaryPath, io);
  }
}

function layoutBlocks(input) {
  const blocks = (Array.isArray(input) ? input : [])
    .map((block, order) => ({ block, order }))
    .sort((left, right) => domOrder(left) - domOrder(right) || left.order - right.order)
    .map(({ block }) => block);
  const images = blocks.filter((block) => block?.kind === 'image');
  const videos = blocks.filter((block) => block?.kind === 'video');
  const media = [...images, ...videos];
  if (media.length === 0) throw new RangeError('Cannot compose detail PNG without image or video media');

  let width = 0;
  for (const block of media) {
    assertMediaBlock(block);
  }
  for (const block of images.length > 0 ? images : videos) width = Math.max(width, block.width);
  assertPositiveInteger('output width', width);
  if (width > MAX_OUTPUT_WIDTH) throw new RangeError('output width exceeds the operational limit');

  const positioned = [];
  let top = 0;
  for (const block of blocks) {
    let height;
    let lines;
    let columnCount;
    let tableCells;
    if (block?.kind === 'image' || block?.kind === 'video') {
      assertMediaBlock(block);
      height = Math.max(1, Math.round(block.height * width / block.width));
    } else if (block?.kind === 'text') {
      lines = wrapText(xmlText(block.text), width);
      height = checkedProduct('text line pixels', lines.length, TEXT_LINE_HEIGHT)
        + 2 * TEXT_VERTICAL_PADDING;
    } else if (block?.kind === 'table') {
      if (!Array.isArray(block.rows) || block.rows.length === 0 || !block.rows.every(Array.isArray)) {
        throw new TypeError('table rows must be a non-empty array of arrays');
      }
      columnCount = 1;
      tableCells = [];
      for (const row of block.rows) {
        if (row.length > MAX_TABLE_COLUMNS) {
          throw new RangeError(`table exceeds the ${MAX_TABLE_COLUMNS}-column operational limit`);
        }
        columnCount = Math.max(columnCount, row.length);
        tableCells.push(row.map((cell) => {
          const value = String(cell == null ? '' : cell);
          if (Buffer.byteLength(value) > MAX_TABLE_CELL_BYTES) {
            throw new RangeError('table cell exceeds the 64 KiB operational limit');
          }
          return xmlText(value);
        }));
      }
      height = checkedProduct('table row pixels', block.rows.length, TABLE_ROW_HEIGHT);
    } else {
      throw new TypeError(`Unsupported detail block kind: ${String(block?.kind)}`);
    }
    if (!Number.isSafeInteger(height) || height <= 0) throw new RangeError('Invalid detail block height');
    if (!Number.isSafeInteger(top + height) || top + height > 0x7fffffff) {
      throw new RangeError('Detail PNG height exceeds the PNG limit');
    }
    positioned.push({ block, top, height, lines, columnCount, tableCells });
    top += height;
  }
  if (top === 0) throw new RangeError('Cannot compose an empty detail PNG');
  return { blocks: positioned, width, height: top };
}

function domOrder(entry) {
  return Number.isInteger(entry.block?.domIndex) && entry.block.domIndex >= 0
    ? entry.block.domIndex
    : entry.order;
}

function assertMediaBlock(block) {
  assertPositiveInteger(`${block.kind} width`, block.width);
  assertPositiveInteger(`${block.kind} height`, block.height);
  const pixels = checkedProduct(`${block.kind} input pixels`, block.width, block.height);
  if (pixels > MAX_INPUT_PIXELS) {
    throw new RangeError(`${block.kind} input pixels exceed the operational limit`);
  }
  if (!Buffer.isBuffer(block.buffer) && !(block.buffer instanceof Uint8Array)) {
    throw new TypeError(`${block.kind} buffer must be a Buffer or Uint8Array`);
  }
}

async function renderBlockIntoStrip(strip, width, stripTop, rowCount, positioned, sharpOperations, signal) {
  const intersectionTop = Math.max(stripTop, positioned.top);
  const intersectionBottom = Math.min(stripTop + rowCount, positioned.top + positioned.height);
  const fragmentHeight = intersectionBottom - intersectionTop;
  const blockOffset = intersectionTop - positioned.top;
  const stripOffset = intersectionTop - stripTop;
  const { block } = positioned;

  if (block.kind === 'image' || block.kind === 'video') {
    const media = await rasterMediaFragment(
      block,
      width,
      positioned.height,
      blockOffset,
      fragmentHeight,
      sharpOperations,
      signal,
    );
    try {
      throwIfAborted(signal);
      blendFragment(strip, width, media, fragmentHeight, stripOffset);
      if (block.kind === 'video') {
        const labelTop = positioned.height - Math.min(VIDEO_LABEL_HEIGHT, positioned.height);
        const labelIntersectionTop = Math.max(blockOffset, labelTop);
        const labelIntersectionBottom = Math.min(blockOffset + fragmentHeight, positioned.height);
        if (labelIntersectionTop < labelIntersectionBottom) {
          const labelHeight = labelIntersectionBottom - labelIntersectionTop;
          const label = await rasterSvg(
            videoLabelSvg(width, positioned.height, labelIntersectionTop, labelHeight),
            width,
            labelHeight,
            sharpOperations,
            signal,
          );
          try {
            throwIfAborted(signal);
            blendFragment(
              strip,
              width,
              label,
              labelHeight,
              stripOffset + labelIntersectionTop - blockOffset,
            );
          } finally {
            label.fill(0);
          }
        }
      }
    } finally {
      media.fill(0);
    }
    return;
  }

  const svg = block.kind === 'text'
    ? textSvg(width, positioned.height, positioned.lines, blockOffset, fragmentHeight)
    : tableGridSvg(width, positioned.tableCells.length, positioned.columnCount, blockOffset, fragmentHeight);
  const rendered = await rasterSvg(svg, width, fragmentHeight, sharpOperations, signal);
  try {
    throwIfAborted(signal);
    blendFragment(strip, width, rendered, fragmentHeight, stripOffset);
  } finally {
    rendered.fill(0);
  }
  if (block.kind === 'table') {
    for (const cellSvg of tableCellSvgs(
      width, positioned.tableCells, positioned.columnCount, blockOffset, fragmentHeight,
    )) {
      throwIfAborted(signal);
      const cell = await rasterSvg(cellSvg, width, fragmentHeight, sharpOperations, signal);
      try {
        throwIfAborted(signal);
        blendFragment(strip, width, cell, fragmentHeight, stripOffset);
      } finally {
        cell.fill(0);
      }
    }
  }
}

async function rasterMediaFragment(block, width, height, top, fragmentHeight, sharpOperations, signal) {
  const { data, info } = await sharpOperations.run({
    kind: 'media', width, height, top, fragmentHeight, limitInputPixels: MAX_INPUT_PIXELS,
  }, block.buffer, signal);
  assertRawFragment(info, width, fragmentHeight);
  return data;
}

async function rasterSvg(svg, width, height, sharpOperations, signal) {
  const svgBytes = Buffer.from(svg);
  if (svgBytes.length > MAX_SVG_BYTES) throw new RangeError('bounded SVG exceeds its byte limit');
  const { data, info } = await sharpOperations.run({
    kind: 'svg', width, height, limitInputPixels: MAX_INPUT_PIXELS,
  }, svgBytes, signal);
  assertRawFragment(info, width, height);
  return data;
}

function assertRawFragment(info, width, height) {
  if (info?.width !== width || info?.height !== height || info?.channels !== 4) {
    throw new Error('Sharp returned an invalid RGBA strip fragment');
  }
}

function blendFragment(destination, width, source, height, destinationTop) {
  for (let y = 0; y < height; y += 1) {
    let destinationOffset = ((destinationTop + y) * width) * 4;
    let sourceOffset = (y * width) * 4;
    for (let x = 0; x < width; x += 1) {
      const alpha = source[sourceOffset + 3];
      if (alpha === 255) {
        destination[destinationOffset] = source[sourceOffset];
        destination[destinationOffset + 1] = source[sourceOffset + 1];
        destination[destinationOffset + 2] = source[sourceOffset + 2];
      } else if (alpha !== 0) {
        const inverse = 255 - alpha;
        destination[destinationOffset] = Math.round(
          (source[sourceOffset] * alpha + destination[destinationOffset] * inverse) / 255,
        );
        destination[destinationOffset + 1] = Math.round(
          (source[sourceOffset + 1] * alpha + destination[destinationOffset + 1] * inverse) / 255,
        );
        destination[destinationOffset + 2] = Math.round(
          (source[sourceOffset + 2] * alpha + destination[destinationOffset + 2] * inverse) / 255,
        );
      }
      destination[destinationOffset + 3] = 255;
      destinationOffset += 4;
      sourceOffset += 4;
    }
  }
}

function wrapText(text, width) {
  const maxUnits = Math.max(1, (width - 2 * TEXT_HORIZONTAL_PADDING) / TEXT_FONT_SIZE);
  const lines = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    let units = 0;
    for (const character of Array.from(paragraph)) {
      const nextUnits = glyphUnits(character);
      if (line && units + nextUnits > maxUnits) {
        lines.push(line);
        line = character;
        units = nextUnits;
      } else {
        line += character;
        units += nextUnits;
      }
    }
    lines.push(line || ' ');
  }
  return lines;
}

function glyphUnits(character) {
  return character.codePointAt(0) > 0xff ? 1 : 0.56;
}

function textSvg(width, height, lines, clipTop, clipHeight) {
  const firstLine = Math.max(0, Math.floor((clipTop - TEXT_VERTICAL_PADDING) / TEXT_LINE_HEIGHT));
  const lastLine = Math.min(
    lines.length,
    Math.ceil((clipTop + clipHeight - TEXT_VERTICAL_PADDING) / TEXT_LINE_HEIGHT),
  );
  const text = lines.slice(firstLine, lastLine).map((line, offset) => {
    const index = firstLine + offset;
    return (
    `<text x="${TEXT_HORIZONTAL_PADDING}" y="${TEXT_VERTICAL_PADDING + TEXT_FONT_SIZE + index * TEXT_LINE_HEIGHT}"`
      + ` font-family="${FONT_FAMILY}" font-size="${TEXT_FONT_SIZE}" fill="#20252b">${escapeSvg(line)}</text>`
    );
  }).join('');
  return svgViewport(width, clipHeight, clipTop, height,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>${text}`);
}

function tableGridSvg(width, rowCount, columnCount, clipTop, clipHeight) {
  const columnWidth = width / columnCount;
  const height = rowCount * TABLE_ROW_HEIGHT;
  let contents = `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`;
  const firstRow = Math.max(0, Math.floor(clipTop / TABLE_ROW_HEIGHT));
  const lastRow = Math.min(rowCount, Math.ceil((clipTop + clipHeight) / TABLE_ROW_HEIGHT));
  for (let rowIndex = firstRow; rowIndex < lastRow; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const x = columnIndex * columnWidth;
      const y = rowIndex * TABLE_ROW_HEIGHT;
      contents += `<rect x="${x}" y="${y}" width="${columnWidth}" height="${TABLE_ROW_HEIGHT}" fill="none" stroke="#aab2bd" stroke-width="1"/>`;
    }
  }
  return svgViewport(width, clipHeight, clipTop, height, contents);
}

function* tableCellSvgs(width, rows, columnCount, clipTop, clipHeight) {
  const columnWidth = width / columnCount;
  const height = rows.length * TABLE_ROW_HEIGHT;
  const firstRow = Math.max(0, Math.floor(clipTop / TABLE_ROW_HEIGHT));
  const lastRow = Math.min(rows.length, Math.ceil((clipTop + clipHeight) / TABLE_ROW_HEIGHT));
  for (let rowIndex = firstRow; rowIndex < lastRow; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const x = columnIndex * columnWidth;
      const y = rowIndex * TABLE_ROW_HEIGHT;
      const clipId = `cell-${rowIndex}-${columnIndex}`;
      const cell = rows[rowIndex][columnIndex] ?? '';
      const contents = `<defs><clipPath id="${clipId}"><rect x="${x + 8}" y="${y + 2}" width="${Math.max(1, columnWidth - 16)}" height="${TABLE_ROW_HEIGHT - 4}"/></clipPath></defs>`
        + `<text x="${x + 12}" y="${y + 36}" clip-path="url(#${clipId})" font-family="${FONT_FAMILY}" font-size="${TABLE_FONT_SIZE}" fill="#20252b">${escapeSvg(cell)}</text>`;
      yield svgViewport(width, clipHeight, clipTop, height, contents);
    }
  }
}

function videoLabelSvg(width, height, clipTop, clipHeight) {
  const labelHeight = Math.min(VIDEO_LABEL_HEIGHT, height);
  const top = height - labelHeight;
  const contents = `<rect x="0" y="${top}" width="${width}" height="${labelHeight}" fill="#000000" fill-opacity="0.7"/>`
    + `<text x="16" y="${top + 32}" font-family="${FONT_FAMILY}" font-size="22" fill="#ffffff">视频（仅导出封面）</text>`;
  return svgViewport(width, clipHeight, clipTop, height, contents);
}

function svgViewport(width, height, viewBoxTop, fullHeight, contents) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 ${viewBoxTop} ${width} ${height}" role="img" aria-label="detail block"><g>${contents}</g><rect x="0" y="0" width="0" height="${fullHeight}" fill="none"/></svg>`;
}

function xmlText(value) {
  let sanitized = '';
  for (const character of String(value == null ? '' : value)) {
    const codePoint = character.codePointAt(0);
    sanitized += codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff)
      ? character
      : '\ufffd';
  }
  return sanitized;
}

function escapeSvg(value) {
  return xmlText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function assertPositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0 || value > 0x7fffffff) {
    throw new RangeError(`${name} must be an integer between 1 and 2147483647`);
  }
}

function checkedProduct(name, ...values) {
  let result = 1;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || result > Number.MAX_SAFE_INTEGER / value) {
      throw new RangeError(`${name} exceeds the safe integer limit`);
    }
    result *= value;
  }
  return result;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw cancelledError();
}

function cancelledError() {
  return Object.assign(new Error('任务已取消'), { code: 'DETAIL_CANCELLED' });
}

function normalizeAbort(error, signal) {
  return signal?.aborted || error?.name === 'AbortError' || error?.code === 'DETAIL_CANCELLED'
    ? cancelledError()
    : error;
}

function safeEmit(emit, event) {
  try {
    emit?.(event);
  } catch {}
}

async function sha256File(filePath, signal, operations) {
  const hash = createHash('sha256');
  const readable = operations.createReadStream(filePath);
  try {
    for await (const chunk of readable) {
      throwIfAborted(signal);
      hash.update(chunk);
    }
  } catch (error) {
    readable.destroy();
    throw error;
  }
  return hash.digest('hex');
}

async function waitForClose(writable) {
  if (writable.closed) return;
  await new Promise((resolve) => {
    writable.once('close', resolve);
    if (!writable.destroyed) writable.destroy();
  });
}

async function removeFile(filePath, operations) {
  try {
    await operations.unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function resolveOperations(overrides) {
  if (overrides == null) return DEFAULT_OPERATIONS;
  if (typeof overrides !== 'object') throw new TypeError('operations must be an object');
  const resolved = { ...DEFAULT_OPERATIONS };
  for (const name of Object.keys(DEFAULT_OPERATIONS)) {
    if (overrides[name] == null) continue;
    if (typeof overrides[name] !== 'function') throw new TypeError(`operations.${name} must be a function`);
    resolved[name] = overrides[name];
  }
  return resolved;
}

module.exports = {
  composeDetailPng,
  MAX_INPUT_PIXELS,
  MAX_OUTPUT_WIDTH,
  MAX_STRIP_BYTES,
  MAX_TABLE_CELL_BYTES,
};
