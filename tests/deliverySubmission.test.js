import { describe, expect, it, vi } from 'vitest';
import { createDeliveryList } from '../src/delivery-list.js';
import { createDeliverySubmission, freezeExportSubmission } from '../src/delivery-submission.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function setup(names = ['A.mp4', 'B.mp4', 'C.mp4']) {
  const project = freezeExportSubmission({
    clips: [{ path: 'C:/mother/program.mov', type: 'video', in: 10, out: 14, offset: 0, vtrack: 0,
      speed: 2, reverse: true, freezeTime: 1 }],
    videoTracks: [{ vt: 0, visible: true }],
    timelineStart: 10, duration: 4, audioPlan: { streams: [] }, audioOnly: false,
  }, {
    mediaName: 'program.mov', fps: 25,
    cues: [{ start: 11, end: 12, track: 0, text: '送出當下' }],
    tracks: [{ name: '對白', visible: true }],
  });
  const list = createDeliveryList({ projectTag: 'program', fps: 25, canvasW: 1920, canvasH: 1080 });
  for (let i = 1; i < names.length; i++) list.add();
  names.forEach((name, index) => { list.setName(index, name); list.setOutDir(index, 'D:/交付'); });
  let modalCurrent = true, workspaceCurrent = true;
  const changes = [];
  const desktop = { listDir: vi.fn(async () => []), exportVideo: vi.fn(async job => 'job-' + job.defaultName) };
  const confirmOverwrite = vi.fn(async () => true);
  const submission = createDeliverySubmission({
    list, initialProject: project, readProject: () => project,
    isCurrent: () => modalCurrent && workspaceCurrent,
    desktop, confirmOverwrite,
    onChanged: change => changes.push(change),
  });
  return {
    project, list, desktop, submission, confirmOverwrite, changes,
    invalidate(kind) { if (kind === 'modal') modalCurrent = false; else workspaceCurrent = false; },
  };
}

describe('delivery submission lifecycle through its production interface', () => {
  it('凍結專案與列，再進行目錄 I/O；後續編輯不改已送出的字幕、時間碼或固定畫格', async () => {
    const s = setup(['A.mp4']);
    const gate = deferred();
    s.desktop.listDir.mockImplementationOnce(() => gate.promise);
    const pending = s.submission.submit();
    expect(s.submission.state().busy).toBe(true);
    s.project.cues[0].text = '等待時編輯';
    s.project.tracks[0].visible = false;
    s.project.clips[0].freezeTime = 3;
    s.project.timelineStart = 30;
    gate.resolve([]);
    await expect(pending).resolves.toMatchObject({ status: 'submitted', accepted: 1, complete: true });
    const job = s.desktop.exportVideo.mock.calls[0][0];
    expect(job.assText).toContain('送出當下');
    expect(job.assText).not.toContain('等待時編輯');
    expect(job.subtitleTracks).toEqual(['對白']);
    expect(job.timelineStartTimecode).toBe('00:00:10:00');
    expect(job.clips[0]).toMatchObject({ speed: 2, reverse: true, freezeTime: 1 });
    expect(s.submission.state().busy).toBe(false);
  });

  it('部分成功後保留失敗與未送出列，重試只送剩餘列', async () => {
    const s = setup();
    const error = new Error('磁碟寫入失敗');
    s.desktop.exportVideo.mockResolvedValueOnce('job-A').mockRejectedValueOnce(error)
      .mockResolvedValueOnce('job-B').mockResolvedValueOnce('job-C');
    await expect(s.submission.submit()).resolves.toMatchObject({ status: 'failed', accepted: 1, error });
    expect(s.list.rows().map(row => row.customName)).toEqual(['B.mp4', 'C.mp4']);
    await expect(s.submission.submit()).resolves.toMatchObject({ status: 'submitted', accepted: 2, complete: true });
    expect(s.desktop.exportVideo.mock.calls.map(([job]) => job.defaultName)).toEqual(['A.mp4', 'B.mp4', 'B.mp4', 'C.mp4']);
  });

  it('null ACK 代表取消，不移除該列或繼續送下一列', async () => {
    const s = setup();
    s.desktop.exportVideo.mockResolvedValue(null);
    await expect(s.submission.submit()).resolves.toEqual({ status: 'cancelled', accepted: 0 });
    expect(s.desktop.exportVideo).toHaveBeenCalledOnce();
    expect(s.list.count()).toBe(3);
  });

  it('ACK 只回收原列，不能刪除等待期間被編輯的新稿', async () => {
    const s = setup(['A.mp4', 'B.mp4']);
    const gate = deferred();
    s.desktop.exportVideo.mockImplementationOnce(() => gate.promise).mockRejectedValueOnce(new Error('拒絕第二份'));
    const pending = s.submission.submit();
    await vi.waitFor(() => expect(s.desktop.exportVideo).toHaveBeenCalledOnce());
    s.list.setName(0, 'A-new.mp4');
    gate.resolve('job-A');
    await pending;
    expect(s.list.rows().map(row => row.customName)).toEqual(['A-new.mp4', 'B.mp4']);
  });

  it('尚未送出的列被編輯後略過其舊稿，其他有效列仍按順序獨立送出', async () => {
    const s = setup();
    const gate = deferred();
    s.desktop.exportVideo.mockImplementationOnce(() => gate.promise);
    const pending = s.submission.submit();
    await vi.waitFor(() => expect(s.desktop.exportVideo).toHaveBeenCalledOnce());
    s.list.setName(1, 'B-new.mp4');
    gate.resolve('job-A');
    await expect(pending).resolves.toMatchObject({ status: 'submitted', accepted: 2, complete: false });
    expect(s.desktop.exportVideo.mock.calls.map(([job]) => job.defaultName)).toEqual(['A.mp4', 'C.mp4']);
    expect(s.list.rows().map(row => row.customName)).toEqual(['B-new.mp4']);
  });

  it.each(['edit-back', 'replace'])('等待期間 %s 不讓原規格的列重新取得舊收據', async kind => {
    const s = setup(['A.mp4', 'B.mp4']);
    const gate = deferred();
    s.desktop.exportVideo.mockImplementationOnce(() => gate.promise);
    const pending = s.submission.submit();
    await vi.waitFor(() => expect(s.desktop.exportVideo).toHaveBeenCalledOnce());
    if (kind === 'edit-back') {
      s.list.setName(1, 'B-new.mp4'); s.list.setName(1, 'B.mp4');
    } else {
      const row = s.list.get(1); s.list.removeAt(1); s.list.add(); s.list.applyRow(1, row);
    }
    gate.resolve('job-A');
    await pending;
    expect(s.desktop.exportVideo).toHaveBeenCalledOnce();
    expect(s.list.rows().map(row => row.customName)).toEqual(['B.mp4']);
  });

  it.each(['modal', 'workspace'])('等待目錄 I/O 時 %s 失效，不送出原工作', async kind => {
    const s = setup();
    const gate = deferred();
    s.desktop.listDir.mockImplementationOnce(() => gate.promise);
    const pending = s.submission.submit();
    s.invalidate(kind); gate.resolve([]);
    await expect(pending).resolves.toMatchObject({ status: 'cancelled', accepted: 0 });
    expect(s.desktop.exportVideo).not.toHaveBeenCalled();
    expect(s.list.count()).toBe(3);
  });

  it.each(['modal', 'workspace'])('等待 ACK 時 %s 失效，不清列或再送後续工作', async kind => {
    const s = setup();
    const gate = deferred();
    s.desktop.exportVideo.mockImplementationOnce(() => gate.promise);
    const pending = s.submission.submit();
    await vi.waitFor(() => expect(s.desktop.exportVideo).toHaveBeenCalledOnce());
    const published = s.changes.length;
    s.invalidate(kind); gate.resolve('job-A');
    await expect(pending).resolves.toMatchObject({ status: 'cancelled', accepted: 1 });
    expect(s.desktop.exportVideo).toHaveBeenCalledOnce();
    expect(s.list.count()).toBe(3);
    expect(s.changes).toHaveLength(published);
    expect(s.submission.state().busy).toBe(false);
  });

  it('同一 session 的重複送出不會建立第二個工作', async () => {
    const s = setup(['A.mp4']);
    const gate = deferred();
    s.desktop.listDir.mockImplementationOnce(() => gate.promise);
    const pending = s.submission.submit();
    await expect(s.submission.submit()).resolves.toEqual({ status: 'busy', accepted: 0 });
    expect(s.desktop.listDir).toHaveBeenCalledOnce();
    gate.resolve([]); await pending;
    expect(s.desktop.exportVideo).toHaveBeenCalledOnce();
  });

  it('目錄檢查的舊 completion 不能覆寫較新預覽的警告', async () => {
    const s = setup(['A.mp4']);
    const old = deferred(), recent = deferred();
    s.desktop.listDir.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => recent.promise);
    const previous = s.submission.previewConflicts();
    s.list.setOutDir(0, 'D:/新目錄');
    const latest = s.submission.previewConflicts();
    recent.resolve([]); await latest;
    old.resolve(['A.mp4']); await previous;
    expect(s.submission.state().warning).toBeNull();
    expect(s.changes).toHaveLength(1);
  });

  it('同名成品需確認覆寫，拒絕後保留草稿且不送出', async () => {
    const s = setup(['flight.mp4']);
    s.list.setFormat(0, 'airline-dmpes');
    s.list.applyRow(0, { ...s.list.get(0), audioPlan: { streams: [{ layout: 'stereo', busIds: ['A1', 'A2'] }] } });
    s.desktop.listDir.mockResolvedValue([{ name: 'flight.mpg' }, { name: 'flight.aac' }, { name: 'flight.manzanita.cfg' }]);
    s.confirmOverwrite.mockResolvedValue(false);
    await expect(s.submission.submit()).resolves.toEqual({ status: 'cancelled', accepted: 0 });
    expect(s.confirmOverwrite).toHaveBeenCalledWith(['flight.mpg']);
    expect(s.submission.state().warning.message).toContain('flight.mpg');
    expect(s.submission.state().warning.message).not.toContain('flight.aac');
    expect(s.desktop.exportVideo).not.toHaveBeenCalled();
    expect(s.list.count()).toBe(1);
  });

  it('非同步覆寫確認後再次檢查 ownership', async () => {
    const s = setup(['A.mp4']);
    const gate = deferred();
    s.desktop.listDir.mockResolvedValue(['A.mp4']);
    s.confirmOverwrite.mockImplementation(() => gate.promise);
    const pending = s.submission.submit();
    await vi.waitFor(() => expect(s.confirmOverwrite).toHaveBeenCalledOnce());
    s.invalidate('workspace'); gate.resolve(true); await pending;
    expect(s.desktop.exportVideo).not.toHaveBeenCalled();
  });

  it('只有真正清空清單才完成，空清單不能重新生成默认交付', async () => {
    const s = setup(['A.mp4']);
    s.list.removeAt(0);
    await expect(s.submission.submit()).resolves.toMatchObject({ status: 'invalid', reason: '清單不能為空' });
    expect(s.desktop.listDir).not.toHaveBeenCalled();
    expect(s.desktop.exportVideo).not.toHaveBeenCalled();
  });

  it.each(['missing-source', 'audio-only-change', 'missing-name', 'duplicate'])('%s 阻擋提交並保留所有列', async kind => {
    const s = setup(['A.mp4', 'B.mp4']);
    if (kind === 'missing-source') s.project.audioPlan.unresolvedSources = [{ name: '離線母素材' }];
    else if (kind === 'audio-only-change') s.project.audioOnly = true;
    else if (kind === 'missing-name') s.list.setName(0, '');
    else s.list.setName(1, 'A.mp4');
    await expect(s.submission.submit()).resolves.toMatchObject({ status: 'invalid', accepted: 0 });
    expect(s.desktop.exportVideo).not.toHaveBeenCalled();
    expect(s.list.count()).toBe(2);
  });
});
