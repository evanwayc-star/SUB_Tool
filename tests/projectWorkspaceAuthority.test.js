// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  createProjectSnapshot,
  migrateProjectSchema,
  validateProjectIntegrity,
  CURRENT_PROJECT_SCHEMA_VERSION,
} from '../src/project.js';

describe('project-workspace-authority', () => {
  it('以 production 專案檔版本建立快照，並保留傳入的領域資料', () => {
    const projectDocument = {
      fps: 29.97,
      dropFrame: true,
      duration: 120.5,
      tracks: [{ id: 't1', name: '主要字幕' }],
      cues: [{ id: 'c1', start: 0, end: 5, text: '測試字幕' }],
      clips: [],
    };

    const snapshot = createProjectSnapshot(projectDocument);
    expect(snapshot.version).toBe(CURRENT_PROJECT_SCHEMA_VERSION);
    expect(snapshot.app).toBe('SUB Tool');
    expect(snapshot.fps).toBe(29.97);
    expect(snapshot.dropFrame).toBe(true);
    expect(snapshot.cues.length).toBe(1);
    expect(snapshot).not.toHaveProperty('savedAt');
  });

  it('將舊專案正規化為可安全交給 Project.apply 的資料形狀', () => {
    const legacy = {
      cues: [{ start: 1, end: 3, text: '舊版字幕' }],
      tracks: null,
      clips: 'not-an-array',
    };

    const migrated = migrateProjectSchema(legacy);
    expect(migrated.tracks.length).toBeGreaterThanOrEqual(1);
    expect(migrated.cues[0].text).toBe('舊版字幕');
    expect(migrated.clips).toEqual([]);
    // 未帶版本的歷史專案仍要讓既有 v1 軌道轉換規則生效。
    expect(migrated.version).toBe(1);
  });

  it('拒絕不能形成專案檔的根資料，並接受正規化後的 production 快照', () => {
    expect(validateProjectIntegrity(null).valid).toBe(false);
    expect(validateProjectIntegrity({ fps: 0, tracks: [], cues: [], clips: [] }).valid).toBe(false);

    const validProject = createProjectSnapshot({
      fps: 24,
      tracks: [{ id: 't1' }],
      cues: [{ id: 'c1' }],
      clips: [],
    });
    expect(validateProjectIntegrity(validProject).valid).toBe(true);
  });
});
