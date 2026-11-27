import { vi } from 'vitest';
import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';

const evidence = createRequire(import.meta.url)('../../electron/mother-source-evidence');
const fingerprint = evidence.portableSourceFingerprint;

// The strict fingerprint also uses asynchronous reads. Meter the file handles
// of the complete SHA pass separately from its bounded first/middle/last samples.
export function observeFullSourceOpen(implementation = (...args) => fsp.open(...args)) {
  const open = vi.fn(implementation);
  const owner = vi.spyOn(evidence, 'portableSourceFingerprint').mockImplementation((source, options) =>
    fingerprint(source, { ...options, fileSystem: { open, stat: (...args) => fsp.stat(...args) } }));
  open.stop = () => owner.mockRestore();
  return open;
}
