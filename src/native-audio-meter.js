/* Native meter polling owns only source-time samples, never the playback clock.
   The caller supplies the current source position and clears when it stops
   consuming levels (pause, hidden mixer, presenter/source handoff). */
const POLL_MS = 100;
const FRESH_MS = 400;
const POSITION_TOLERANCE = 0.5;

function validatedSample(value, mixes) {
  if (!value || !Number.isFinite(value.time) || value.time < 0 || !Array.isArray(value.levels)) return null;
  if (value.levels.some(item => !item
    || !Number.isInteger(item.sourceStream) || item.sourceStream < 0
    || !Number.isInteger(item.sourceChannel) || item.sourceChannel < 0
    || !Number.isFinite(item.level) || item.level < 0)) return null;
  const result = { time: value.time, levels: value.levels.map(({ sourceStream, sourceChannel, level }) =>
    ({ sourceStream, sourceChannel, level })) };
  if (mixes !== undefined) {
    if (!Array.isArray(value.busLevels) || value.busLevels.length !== mixes.length
      || value.busLevels.some((item, index) => item?.busId !== mixes[index].busId
        || !Number.isFinite(item.level) || item.level < 0)) return null;
    result.busLevels = value.busLevels.map(({ busId, level }) => ({ busId, level }));
  }
  return result;
}

export function createNativeAudioMeterClient({ read, stop, now = () => performance.now() }) {
  let active = null;
  let generation = 0;
  let snapshot = null;
  let inFlight = null;
  let stopping = null;
  let lastReadAt = -Infinity;

  function invalidate() {
    generation++;
    snapshot = null;
    // A second source change while stop is pending cannot have started new
    // work. Reuse that stop barrier instead of sending another IPC every rAF.
    if (stopping) return;
    const owner = {};
    stopping = owner;
    const finish = () => { if (stopping === owner) stopping = null; };
    try { Promise.resolve(stop()).then(finish, finish); }
    catch { finish(); }
  }

  function clear() {
    if (!active) return;
    active = null;
    invalidate();
  }

  function fresh(value, startedAt, at) {
    return value && active && at >= startedAt && at - startedAt <= FRESH_MS
      && Math.abs(value.time - active.time) <= POSITION_TOLERANCE;
  }

  function poll(at) {
    if (inFlight || stopping || at - lastReadAt < POLL_MS) return;
    const owner = { generation, startedAt: at };
    inFlight = owner;
    lastReadAt = at;
    const { path, time, rate, mixes } = active;
    let operation;
    try { operation = read({ path, time, rate, ...(mixes === undefined ? {} : { mixes }) }); }
    catch { operation = null; }
    Promise.resolve(operation).then(value => {
      if (generation !== owner.generation || !active) return;
      const sample = validatedSample(value, mixes);
      snapshot = fresh(sample, owner.startedAt, now()) ? { sample, at: owner.startedAt } : null;
    }, () => {
      if (generation === owner.generation) snapshot = null;
    }).finally(() => {
      if (inFlight === owner) inFlight = null;
    });
  }

  function sample(request) {
    const rate = request?.rate ?? 1;
    if (typeof request?.path !== 'string' || !request.path
      || !Number.isFinite(request.time) || request.time < 0
      || !Number.isFinite(rate) || rate <= 0) {
      clear();
      return null;
    }
    const at = now();
    let mixes, mixKey;
    try {
      // Own the requested gains: a fader edit cannot mutate an in-flight call.
      if (request.mixes !== undefined) {
        mixes = request.mixes.map(mix => ({ busId: mix.busId, inputs: mix.inputs.map(input => ({
          sourceStream: input.sourceStream, sourceChannel: input.sourceChannel, gain: input.gain,
        })) }));
        mixKey = JSON.stringify(mixes);
      }
    } catch { clear(); return null; }
    const next = { path: request.path, sourceKey: request.sourceKey, time: request.time, rate, at, mixes, mixKey };
    if (active) {
      const expectedTime = active.time + (at - active.at) / 1000 * active.rate;
      if (next.path !== active.path || next.sourceKey !== active.sourceKey || next.rate !== active.rate
        || Math.abs(next.time - expectedTime) > POSITION_TOLERANCE) invalidate();
      else if (next.mixKey !== active.mixKey) {
        // Only the interpretation changed. Revoke old bus peaks, but preserve
        // the source decoder and its signed PCM history for the next read.
        generation++;
        snapshot = null;
      }
    }
    active = next;
    if (snapshot && !fresh(snapshot.sample, snapshot.at, at)) snapshot = null;
    poll(at);
    return snapshot?.sample || null;
  }

  return { sample, clear };
}
