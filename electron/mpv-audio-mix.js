'use strict';

// Native adapter only: project Solo/Mute/routing is already interpreted by the
// renderer. Accept numeric source coordinates, never caller-supplied filters.
function buildMpvAudioMix(audio, channels) {
  const invalid = () => new TypeError('無效的原生音訊混音配線');
  if (!Array.isArray(audio) || audio.length > 32 || !Array.isArray(channels)) throw invalid();
  const counts = audio.map(stream => stream?.channels);
  if (counts.some(count => !Number.isInteger(count) || count < 1 || count > 64)) throw invalid();
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total > 128 || channels.length !== total) throw invalid();
  const gains = counts.map(count => new Array(count));
  for (const channel of channels) {
    const { sourceStream, sourceChannel, gain } = channel || {};
    if (!Number.isInteger(sourceStream) || sourceStream < 0 || sourceStream >= counts.length
      || !Number.isInteger(sourceChannel) || sourceChannel < 0 || sourceChannel >= counts[sourceStream]
      || typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0 || gain > 64
      || gains[sourceStream][sourceChannel] !== undefined) throw invalid();
    gains[sourceStream][sourceChannel] = gain;
  }
  if (!total) return '';
  // Each cached Mono voice feeds both monitor speakers at equal amplitude.
  // Explicit stereo also prevents mpv's implicit Mono upmix from applying -3 dB.
  const filters = gains.map((values, stream) => {
    const sum = values.map((gain, channel) => `${gain}*c${channel}`).join('+');
    const output = gains.length === 1 ? 'ao' : `mix${stream}`;
    return `[aid${stream + 1}]pan=stereo|c0=${sum}|c1=${sum}[${output}]`;
  });
  if (gains.length > 1) filters.push(`${gains.map((_, stream) => `[mix${stream}]`).join('')}amix=inputs=${gains.length}:normalize=0[ao]`);
  return filters.join(';');
}

module.exports = { buildMpvAudioMix };
