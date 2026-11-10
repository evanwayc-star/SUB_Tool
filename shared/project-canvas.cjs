// Project canvas admission shared by the persisted renderer document and native
// presenter. Keep captured-frame allocation bounded, including 8K portrait.
const MAX_CANVAS_DIMENSION = 8192;
const MAX_CANVAS_PIXELS = 8192 * 4320;

function validProjectCanvas(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height)
    && value.width >= 2 && value.height >= 2
    && value.width <= MAX_CANVAS_DIMENSION && value.height <= MAX_CANVAS_DIMENSION
    && value.width * value.height <= MAX_CANVAS_PIXELS;
}

module.exports = { MAX_CANVAS_DIMENSION, MAX_CANVAS_PIXELS, validProjectCanvas };
