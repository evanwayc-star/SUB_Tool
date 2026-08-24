import { describe, it, expect } from 'vitest';
import {
  createProjectSnapshot,
  migrateProjectSchema,
  validateProjectIntegrity,
  CURRENT_PROJECT_SCHEMA_VERSION,
} from '../src/project-workspace-authority.js';

describe('project-workspace-authority', () => {
  it('從狀態建立完整序列化專案快照', () => {
    const mockState = {
      fps: 29.97,
      dropFrame: true,
      duration: 120.5,
      tracks: [{ id: 't1', name: '主要字幕' }],
      cues: [{ id: 'c1', start: 0, end: 5, text: '測試字幕' }],
      clips: [],
    };

    const snapshot = createProjectSnapshot(mockState);
    expect(snapshot.version).toBe(CURRENT_PROJECT_SCHEMA_VERSION);
    expect(snapshot.fps).toBe(29.97);
    expect(snapshot.dropFrame).toBe(true);
    expect(snapshot.cues.length).toBe(1);
    expect(snapshot.savedAt).toBeDefined();
  });

  it('自動向上遷移舊版本專案結構', () => {
    const legacy = {
      cues: [{ start: 1, end: 3, text: '舊版字幕' }],
    };

    const migrated = migrateProjectSchema(legacy);
    expect(migrated.tracks.length).toBeGreaterThanOrEqual(1);
    expect(migrated.cues[0].id).toBeDefined();
    expect(migrated.cues[0].track).toBe(0);
  });

  it('專案完整性校驗', () => {
    expect(validateProjectIntegrity(null).valid).toBe(false);
    expect(validateProjectIntegrity({ fps: 0 }).valid).toBe(false);

    const validProject = {
      fps: 24,
      tracks: [{ id: 't1' }],
      cues: [{ id: 'c1' }],
    };
    expect(validateProjectIntegrity(validProject).valid).toBe(true);
  });
});
