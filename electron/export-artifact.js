'use strict';

const { getDeliveryFormatPreset } = require('../shared/delivery-formats.cjs');
const nativeDisc = require('./disc-authoring');
const { finalizeAirlineOutput } = require('./airline-output');
const { finalizeModFhdTransport } = require('./mod-fhd-transport');

/** Watchdog-private artifact lifecycle. Lease ownership stays with the caller.
 * prepare/settle are serialized: cancellation cannot release a workspace while
 * its preparation, native writer, finalizer or cleanup is still in flight.
 * Adapters are injected by the standalone bootstrap, never by the IPC payload.
 */
function createExportArtifact(config, owner = {}, adapters = {}) {
  const { outputFormat: format, outPath, args, discAudioPlan } = config;
  const preset = getDeliveryFormatPreset(format);
  const isDisc = preset?.kind === 'disc';
  const disc = adapters.disc || nativeDisc;
  const airline = adapters.finalizeAirline || finalizeAirlineOutput;
  const modFhd = adapters.finalizeModFhd || finalizeModFhdTransport;
  const { signal, onOutputStart, onProcess, onProgress } = owner;
  let tempDir;
  let stage = null;
  let preparing = null;
  let settling = null;

  function prepare(options = {}) {
    if (settling) return Promise.reject(new Error('匯出成品已結束，不能重新準備'));
    if (preparing) return preparing;
    tempDir = options.tempDir;
    preparing = (async () => {
      signal?.throwIfAborted();
      if (isDisc) {
        stage = await disc.prepareDiscOutput(format, { tempDir });
        signal?.throwIfAborted();
        return [...args.slice(0, -1), stage.encodedPath];
      }
      await onOutputStart?.();
      signal?.throwIfAborted();
      return args;
    })();
    return preparing;
  }

  function settle({ encoded = false } = {}) {
    if (settling) return settling;
    settling = (async () => {
      let preparationFailed = false;
      if (preparing) await preparing.catch(() => { preparationFailed = true; });
      const outcome = { error: null, reason: null, cleanupError: null };
      if (encoded && preparing && !preparationFailed && !signal?.aborted) {
        try {
          if (isDisc) {
            const label = format === 'dvd-iso' ? '製作 DVD ISO' : '製作 BD ISO';
            onProgress?.({ label, pct: 95 });
            await disc.finalizeDiscOutput(format, stage.encodedPath, outPath, {
              signal, audioPlan: discAudioPlan, onOutputStart, onProcess,
              onProgress: percent => onProgress?.({ label, pct: 95 + percent * 0.04 }),
            });
          } else if (preset?.transport === 'airline') {
            await airline(format, outPath, { signal, tempDir });
          } else if (format === 'mod-fhd') {
            await modFhd(outPath, { signal });
          }
        } catch (error) {
          outcome.error = error;
          outcome.reason = isDisc ? 'disc-finalize-failed'
            : preset?.transport === 'airline' ? 'airline-finalize-failed' : 'mod-fhd-finalize-failed';
        }
      }
      if (stage) {
        try {
          await disc.cleanupDiscOutput(stage, { tempDir });
        } catch (error) {
          outcome.cleanupError = error;
          outcome.error ||= error;
          outcome.reason ||= 'disc-cleanup-failed';
        }
      }
      return outcome;
    })();
    return settling;
  }

  return Object.freeze({ prepare, settle });
}

module.exports = { createExportArtifact };
