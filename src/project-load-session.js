/*
 * A project load spans filesystem checks, player startup, and background
 * restoration.  Keeping that temporary material on State made the hand-off
 * between Project and Media implicit, and let a delayed load observe a newer
 * project's restore data.  This module owns both the latest-wins transaction
 * and the explicit restore plan passed to Media.
 */

class ProjectRestorePlan {
  #clips;
  #externalAudioSources;
  #playhead;
  #mediaRelink;

  constructor({ clips = [], externalAudioSources = [], playhead = null, mediaRelink = false } = {}) {
    this.#clips = Array.isArray(clips) ? clips : [];
    this.#externalAudioSources = Array.isArray(externalAudioSources) ? externalAudioSources : [];
    this.#playhead = Number.isFinite(playhead) ? Math.max(0, playhead) : null;
    this.#mediaRelink = mediaRelink === true;
  }

  pendingClips() { return this.#clips; }
  takeClips() {
    const clips = this.#clips;
    this.#clips = [];
    return clips;
  }
  replaceClips(clips) { this.#clips = Array.isArray(clips) ? clips : []; }

  pendingExternalAudioSources() { return this.#externalAudioSources; }
  replaceExternalAudioSources(sources) {
    this.#externalAudioSources = Array.isArray(sources) ? sources : [];
  }

  peekPlayhead() { return this.#playhead; }
  clearPlayhead() { this.#playhead = null; }

  consumeMediaRelink() {
    const relink = this.#mediaRelink;
    this.#mediaRelink = false;
    return relink;
  }

  needsMediaRelink() { return this.#mediaRelink; }
}

class ProjectLoadSession {
  #generation = 0;
  #tail = Promise.resolve();
  #activePlan = null;

  get activePlan() { return this.#activePlan; }
  get generation() { return this.#generation; }

  begin() {
    this.#generation += 1;
    this.#activePlan = null;
    return this.#generation;
  }

  isCurrent(generation) { return generation === this.#generation; }

  append(generation, work) {
    const result = this.#tail.catch(() => {}).then(() => {
      if (!this.isCurrent(generation)) return undefined;
      return work();
    });
    // A rejected public call must not poison the serial tail.  Its caller still
    // receives the original rejection through result.
    this.#tail = result.catch(() => {});
    return result;
  }

  createRestorePlan(generation, material) {
    if (generation != null && !this.isCurrent(generation)) return null;
    const plan = new ProjectRestorePlan(material);
    this.#activePlan = plan;
    return plan;
  }

  clearPlan(plan = null) {
    if (!plan || this.#activePlan === plan) this.#activePlan = null;
  }
}

export { ProjectLoadSession, ProjectRestorePlan };
