'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { rename, stat, unlink } = require('node:fs/promises');
const path = require('node:path');
const { PngStreamWriter } = require('./png-stream-writer');

const DEFAULT_STRIP_HEIGHT = 512;
const TEXT_FONT_SIZE = 28;
const TEXT_LINE_HEIGHT = 42;
const TEXT_HORIZONTAL_PADDING = 24;
const TEXT_VERTICAL_PADDING = 16;
const TABLE_FONT_SIZE = 22;
const TABLE_ROW_HEIGHT = 56;
const VIDEO_LABEL_HEIGHT = 48;
const FONT_FAMILY = 'Noto Sans CJK SC';

async function composeDetailPng(blocks, {
  outputPath,
  stripHeight = DEFAULT_STRIP_HEIGHT,
  signal,
  sharp,
  emit,
} = {}) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new TypeError('outputPath must be a non-empty path');
  }
  if (typeof sharp !== 'function') throw new TypeError('sharp must be a function');
  assertPositiveInteger('stripHeight', stripHeight);
  throwIfAborted(signal);

  const layout = layoutBlocks(blocks);
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.part-${process.pid}-${randomUUID()}`,
  );
  const writable = createWriteStream(temporaryPath, { flags: 'wx' });
  const writer = new PngStreamWriter(layout.width, layout.height, writable);
  let completed = false;

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
          await renderBlockIntoStrip(strip, layout.width, stripTop, rowCount, positioned, sharp, signal);
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
    const fileStat = await stat(temporaryPath);
    const sha256 = await sha256File(temporaryPath, signal);
    throwIfAborted(signal);
    await rename(temporaryPath, outputPath);
    completed = true;
    return { width: layout.width, height: layout.height, size: fileStat.size, sha256 };
  } catch (error) {
    if (!writable.destroyed) writer.abort(error);
    await waitForClose(writable);
    await removeFile(temporaryPath);
    throw normalizeAbort(error, signal);
  } finally {
    if (!completed) await removeFile(temporaryPath);
  }
}

function layoutBlocks(input) {
  const blocks = (Array.isArray(input) ? input : [])
    .map((block, order) => ({ block, order }))
    .sort((left, right) => domOrder(left) - domOrder(right) || left.order - right.order)
    .map(({ block }) => block);
  const media = blocks.filter((block) => block?.kind === 'image' || block?.kind === 'video');
  if (media.length === 0) throw new RangeError('Cannot compose detail PNG without image or video media');

  let width = 0;
  for (const block of media) {
    assertMediaBlock(block);
    width = Math.max(width, block.width);
  }
  assertPositiveInteger('output width', width);

  const positioned = [];
  let top = 0;
  for (const block of blocks) {
    let height;
    let lines;
    if (block?.kind === 'image' || block?.kind === 'video') {
      assertMediaBlock(block);
      height = Math.max(1, Math.round(block.height * width / block.width));
    } else if (block?.kind === 'text') {
      lines = wrapText(xmlText(block.text), width);
      height = lines.length * TEXT_LINE_HEIGHT + 2 * TEXT_VERTICAL_PADDING;
    } else if (block?.kind === 'table') {
      if (!Array.isArray(block.rows) || block.rows.length === 0 || !block.rows.every(Array.isArray)) {
        throw new TypeError('table rows must be a non-empty array of arrays');
      }
      height = block.rows.length * TABLE_ROW_HEIGHT;
    } else {
      throw new TypeError(`Unsupported detail block kind: ${String(block?.kind)}`);
    }
    if (!Number.isSafeInteger(height) || height <= 0) throw new RangeError('Invalid detail block height');
    if (!Number.isSafeInteger(top + height) || top + height > 0x7fffffff) {
      throw new RangeError('Detail PNG height exceeds the PNG limit');
    }
    positioned.push({ block, top, height, lines });
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
  if (!Buffer.isBuffer(block.buffer) && !(block.buffer instanceof Uint8Array)) {
    throw new TypeError(`${block.kind} buffer must be a Buffer or Uint8Array`);
  }
}

async function renderBlockIntoStrip(strip, width, stripTop, rowCount, positioned, sharp, signal) {
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
      sharp,
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
            sharp,
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
    : tableSvg(width, block.rows, blockOffset, fragmentHeight);
  const rendered = await rasterSvg(svg, width, fragmentHeight, sharp);
  try {
    throwIfAborted(signal);
    blendFragment(strip, width, rendered, fragmentHeight, stripOffset);
  } finally {
    rendered.fill(0);
  }
}

async function rasterMediaFragment(block, width, height, top, fragmentHeight, sharp) {
  const { data, info } = await sharp(block.buffer, {
    animated: false,
    page: 0,
    pages: 1,
    limitInputPixels: false,
    sequentialRead: true,
  })
    .resize(width, height, { fit: 'fill' })
    .extract({ left: 0, top, width, height: fragmentHeight })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assertRawFragment(info, width, fragmentHeight);
  return data;
}

async function rasterSvg(svg, width, height, sharp) {
  const { data, info } = await sharp(Buffer.from(svg), { limitInputPixels: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
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
  const text = lines.map((line, index) => (
    `<text x="${TEXT_HORIZONTAL_PADDING}" y="${TEXT_VERTICAL_PADDING + TEXT_FONT_SIZE + index * TEXT_LINE_HEIGHT}"`
      + ` font-family="${FONT_FAMILY}" font-size="${TEXT_FONT_SIZE}" fill="#20252b">${escapeSvg(line)}</text>`
  )).join('');
  return svgViewport(width, clipHeight, clipTop, height,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>${text}`);
}

function tableSvg(width, rows, clipTop, clipHeight) {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const columnWidth = width / columnCount;
  const height = rows.length * TABLE_ROW_HEIGHT;
  let contents = `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const x = columnIndex * columnWidth;
      const y = rowIndex * TABLE_ROW_HEIGHT;
      const clipId = `cell-${rowIndex}-${columnIndex}`;
      contents += `<defs><clipPath id="${clipId}"><rect x="${x + 8}" y="${y + 2}" width="${Math.max(1, columnWidth - 16)}" height="${TABLE_ROW_HEIGHT - 4}"/></clipPath></defs>`;
      contents += `<rect x="${x}" y="${y}" width="${columnWidth}" height="${TABLE_ROW_HEIGHT}" fill="none" stroke="#aab2bd" stroke-width="1"/>`;
      contents += `<text x="${x + 12}" y="${y + 36}" clip-path="url(#${clipId})" font-family="${FONT_FAMILY}" font-size="${TABLE_FONT_SIZE}" fill="#20252b">${escapeSvg(xmlText(rows[rowIndex][columnIndex]))}</text>`;
    }
  }
  return svgViewport(width, clipHeight, clipTop, height, contents);
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
  return Array.from(String(value == null ? '' : value), (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff)
      ? character
      : '\ufffd';
  }).join('');
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

async function sha256File(filePath, signal) {
  const hash = createHash('sha256');
  const readable = createReadStream(filePath);
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

async function removeFile(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

module.exports = { composeDetailPng };
