import { describe, expect, it } from 'vitest';
import { createSubtitleCompareSession } from '../src/subtitle-compare-session.js';

function snapshot() {
  return {
    tracks: [{ name: 'A' }, { name: 'B' }],
    cues: [
      { id: 'left', track: 0, start: 10, end: 11, text: '左' },
      { id: 'right', track: 1, start: 10, end: 11, text: '右' },
    ],
    fps: 25,
    dropFrame: false,
  };
}

describe('字幕比對 session', () => {
  it('未開啟視窗時不傳送 snapshot，開啟後只透過 port 傳一份 plan', () => {
    const sent = [];
    const session = createSubtitleCompareSession({
      port: {
        open: payload => sent.push({ kind: 'open', payload }),
        sync: payload => sent.push({ kind: 'sync', payload }),
      },
    });

    expect(session.sync(snapshot())).toBe(false);
    expect(sent).toEqual([]);

    expect(session.open(snapshot())).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('open');
    expect(sent[0].payload.plan.rows).toHaveLength(1);
  });

  it('每次同步遞增 revision，過時 command fail closed', () => {
    const sent = [];
    const session = createSubtitleCompareSession({
      port: {
        open: payload => sent.push(payload),
        sync: payload => sent.push(payload),
      },
    });

    session.open(snapshot());
    const oldRevision = sent[0].revision;
    session.sync(snapshot());

    expect(sent).toHaveLength(2);
    expect(sent[1].revision).toBe(oldRevision + 1);
    expect(session.handleCommand({ type: 'seek', revision: oldRevision, cueId: 'left' }))
      .toEqual({ accepted: false, reason: 'stale-revision' });
  });

  it('只接受 snapshot 內存在的 stable cue ID，並交給 application callback', () => {
    const matched = [];
    const session = createSubtitleCompareSession({
      onMatchStyle: command => { matched.push(command); return true; },
    });

    session.open(snapshot());
    const revision = session.revision();

    expect(session.handleCommand({
      type: 'match-style', revision, targetCueId: 'left', sourceCueId: 'right',
    })).toEqual({ accepted: true, revision });
    expect(matched).toEqual([{ targetCueId: 'left', sourceCueId: 'right', revision }]);
    expect(session.handleCommand({
      type: 'match-style', revision, targetCueId: 'left', sourceCueId: 'not-a-cue',
    })).toEqual({ accepted: false, reason: 'unknown-cue' });
  });

  it('關閉後不再同步，也拒絕 command', () => {
    const sent = [];
    const session = createSubtitleCompareSession({
      port: { open: payload => sent.push(payload), sync: payload => sent.push(payload) },
    });

    session.open(snapshot());
    const revision = session.revision();
    expect(session.close()).toBe(true);
    expect(session.sync(snapshot())).toBe(false);
    expect(session.handleCommand({ type: 'seek', revision, cueId: 'left' }))
      .toEqual({ accepted: false, reason: 'closed' });
    expect(sent).toHaveLength(1);
  });
});
