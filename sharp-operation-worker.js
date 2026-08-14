'use strict';

const { parentPort } = require('node:worker_threads');
const sharp = require('sharp');

parentPort.on('message', async ({ id, input, operation }) => {
  try {
    let pipeline;
    const bytes = Buffer.from(input);
    if (operation.kind === 'media') {
      pipeline = sharp(bytes, {
        animated: false,
        page: 0,
        pages: 1,
        limitInputPixels: operation.limitInputPixels,
        sequentialRead: true,
      })
        .resize(operation.width, operation.height, { fit: 'fill' })
        .extract({ left: 0, top: operation.top, width: operation.width, height: operation.fragmentHeight })
        .ensureAlpha()
        .raw();
    } else if (operation.kind === 'svg') {
      pipeline = sharp(bytes, { limitInputPixels: operation.limitInputPixels }).ensureAlpha().raw();
    } else {
      throw new TypeError(`Unsupported Sharp operation: ${String(operation.kind)}`);
    }
    parentPort.postMessage({ type: 'started', id });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    parentPort.postMessage({ type: 'result', id, data, info });
  } catch (error) {
    parentPort.postMessage({
      type: 'failure',
      id,
      error: { message: error?.message || String(error), name: error?.name, code: error?.code },
    });
  }
});
