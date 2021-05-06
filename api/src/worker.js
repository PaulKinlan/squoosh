import { autoOptimize } from './auto-optimizer.js';
import { codecs as supportedFormats, preprocessors } from './codecs.js';

async function decodeFile(file) {
  const buffer = await file.arrayBuffer();
  const firstChunk = buffer.slice(0, 16);
  const firstChunkString = new Uint8Array(firstChunk).reduce(
    (prev, curr) => prev + String.fromCodePoint(curr),
    '',
  );
  const key = Object.entries(supportedFormats).find(([name, { detectors }]) =>
    detectors.some((detector) => detector.exec(firstChunkString)),
  )?.[0];
  if (!key) {
    throw Error(`${file} has an unsupported format`);
  }
  const rgba = (await supportedFormats[key].dec()).decode(
    new Uint8Array(buffer),
  );
  return {
    file,
    bitmap: rgba,
    size: buffer.length,
  };
}

async function preprocessImage({ preprocessorName, options, file }) {
  const preprocessor = await preprocessors[preprocessorName].instantiate();
  file.bitmap = await preprocessor(
    file.bitmap.data,
    file.bitmap.width,
    file.bitmap.height,
    options,
  );
  return file;
}

async function encodeFile({
  file,
  size,
  bitmap: bitmapIn,
  outputFile,
  encName,
  encConfig,
  optimizerButteraugliTarget,
  maxOptimizerRounds,
}) {
  let out, infoText;
  const encoder = await supportedFormats[encName].enc();
  if (encConfig === 'auto') {
    const optionToOptimize = supportedFormats[encName].autoOptimize.option;
    const decoder = await supportedFormats[encName].dec();
    const encode = (bitmapIn, quality) =>
      encoder.encode(
        bitmapIn.data,
        bitmapIn.width,
        bitmapIn.height,
        Object.assign({}, supportedFormats[encName].defaultEncoderOptions, {
          [optionToOptimize]: quality,
        }),
      );
    const decode = (binary) => decoder.decode(binary);
    const { bitmap, binary, quality } = await autoOptimize(
      bitmapIn,
      encode,
      decode,
      {
        min: supportedFormats[encName].autoOptimize.min,
        max: supportedFormats[encName].autoOptimize.max,
        butteraugliDistanceGoal: optimizerButteraugliTarget,
        maxRounds: maxOptimizerRounds,
      },
    );
    out = binary;
    const opts = {
      // 5 significant digits is enough
      [optionToOptimize]: Math.round(quality * 10000) / 10000,
    };
    infoText = ` using --${encName} '${JSON.stringify(opts)}'`;
  } else {
    out = encoder.encode(
      bitmapIn.data.buffer,
      bitmapIn.width,
      bitmapIn.height,
      encConfig,
    );
  }
  return {
    infoText,
    inputSize: size,
    inputFile: file,
    outputFile,
    out,
    outputSize: out.length,
  };
}

// both decoding and encoding go through the worker pool
function handleJob(params) {
  console.log(params);
  const { operation } = params;
  switch (operation) {
    case 'encode':
      return encodeFile(params);
    case 'decode':
      return decodeFile(params.file);
    case 'preprocess':
      return preprocessImage(params);
    default:
      throw Error(`Invalid job "${operation}"`);
  }
}

self.addEventListener('message', async (event) => {
  const { msg, id } = event.data;
  const result = await handleJob(msg);
  self.postMessage({ result, id });
});
