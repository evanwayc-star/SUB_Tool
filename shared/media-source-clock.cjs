/* Player/container seconds are translated once to the video's source zero. */
'use strict';

function timestampOffset(clock) {
  const offset = Number(clock?.timestampOffset);
  return Number.isFinite(offset) ? offset : 0;
}

function sourceClockTime(playerTime, clock) {
  return Number(playerTime) + timestampOffset(clock);
}

function playerClockTime(sourceTime, clock) {
  return Number(sourceTime) - timestampOffset(clock);
}

function sourceCeilTick(seconds) {
  const ticks=Number(seconds)*1e6,nearest=Math.round(ticks);
  // Arithmetic such as 30/(30000/1001) can put an integral timestamp one
  // floating point ULP above its tick. Absorb representation error only.
  const tolerance=4*Number.EPSILON*Math.max(1,Math.abs(ticks));
  return Math.ceil(Math.abs(ticks-nearest)<=tolerance?nearest:ticks);
}

function sourceFrameTargetUs(sourceTime, clip) {
  const first=sourceCeilTick(Number(clip.in)||0);
  const last=Math.max(first,sourceCeilTick(clip.out)-1);
  return Math.max(first,Math.min(last,Math.round(Number(sourceTime)*1e6)));
}

module.exports = { timestampOffset, sourceClockTime, playerClockTime, sourceFrameTargetUs };
