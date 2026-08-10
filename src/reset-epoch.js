/*
  Multiple asset imports may run concurrently inside one project, so this is
  deliberately not a latest-wins session.  Every captured token remains valid
  until reset() advances the epoch; all continuations from the old project then
  fail the same ownership check.
*/
export class ResetEpoch {
  constructor() { this.generation = 0; }

  capture(identity = null, owns = null) {
    return Object.freeze({
      generation: this.generation,
      identity,
      upstreamOwns: typeof owns === 'function' ? owns : null,
    });
  }

  owns(token) {
    if (!token || token.generation !== this.generation) return false;
    try { return !token.upstreamOwns || token.upstreamOwns(); }
    catch (error) { return false; }
  }

  invalidate() {
    this.generation += 1;
    return this.generation;
  }
}
