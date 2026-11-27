const RATE = 16000,
  PHASES = 128;
let previousRate, previousKernels;

// A zero-phase, windowed sinc limits the bandwidth before decimation.
// Keep one filter bank; a bound on rate or selection never allocates a
// whole intermediate source or changes the original sample clock.
export function speechFilterRadius(rate) {
  return rate > RATE ? Math.ceil((14 * rate) / RATE) : 1;
}

function filterBank(rate, radius) {
  if (previousRate === rate) return previousKernels;
  const cutoff = 7200 / rate;
  const kernels = Array.from({ length: PHASES }, (_, phase) => {
    const taps = new Float32Array(radius * 2 + 1);
    let total = 0;
    for (let j = -radius; j <= radius; j++) {
      const x = j - phase / PHASES;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const window =
        0.42 + 0.5 * Math.cos((Math.PI * x) / (radius + 1)) + 0.08 * Math.cos((2 * Math.PI * x) / (radius + 1));
      total += taps[j + radius] = sinc * window;
    }
    for (let j = 0; j < taps.length; j++) taps[j] /= total;
    return taps;
  });
  previousRate = rate;
  previousKernels = kernels;
  return kernels;
}

export function addSpeechChannel(
  target,
  data,
  rate,
  firstSample,
  { gain = 1, validFrom = 0, validTo = data.length } = {}
) {
  if (rate === RATE && Number.isInteger(firstSample)) {
    const start = Math.max(0, validFrom - firstSample),
      end = Math.min(target.length, validTo - firstSample);
    for (let i = start; i < end; i++) target[i] += data[firstSample + i] * gain;
    return;
  }
  const ratio = rate / RATE;
  const radius = speechFilterRadius(rate);
  const kernels = rate > RATE ? filterBank(rate, radius) : null;
  for (let i = 0; i < target.length; i++) {
    const at = firstSample + i * ratio,
      base = Math.floor(at);
    if (at < validFrom || at >= validTo) continue;
    if (!kernels) {
      const head = data[base] || 0,
        tail = base + 1 < validTo ? data[base + 1] || 0 : head;
      target[i] += (head + (tail - head) * (at - base)) * gain;
      continue;
    }
    const taps = kernels[Math.min(PHASES - 1, Math.floor((at - base) * PHASES))];
    const left = Math.max(validFrom, base - radius),
      right = Math.min(validTo - 1, base + radius);
    let value = 0;
    // Extend the actual end samples, so a constant signal does not fade
    // in and out at the physical ends of a short recording.
    for (let j = base - radius; j < left; j++) value += data[left] * taps[j - base + radius];
    for (let j = left; j <= right; j++) value += data[j] * taps[j - base + radius];
    for (let j = right + 1; j <= base + radius; j++) value += data[right] * taps[j - base + radius];
    target[i] += value * gain;
  }
}

// Long browser decodes share the UI thread. Bound uninterrupted DSP work
// and observe cancellation between slices without changing the sample phase.
export async function addSpeechChannelInBlocks(target, data, rate, firstSample, options, check) {
  let lastYield = performance.now();
  for (let first = 0; first < target.length; first += 32768) {
    check();
    const slice = target.subarray(first, first + 32768);
    addSpeechChannel(slice, data, rate, firstSample + (first * rate) / RATE, options);
    if (performance.now() - lastYield >= 24 && first + slice.length < target.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
}
