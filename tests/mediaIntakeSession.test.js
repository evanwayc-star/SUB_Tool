import { describe, expect, it, vi } from 'vitest';
import { MediaIntakeSession, waitForOwnedMediaMetadata } from '../src/media-intake-engine.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

describe('MediaIntakeSession resource ownership', () => {
  it('音訊 metadata 逾時時拒絕載入並釋放失敗元素', async () => {
    const session = new MediaIntakeSession();
    const element = { src: '', readyState: 0, pause: vi.fn() };
    await expect(session.materializeAudioElements([{ file: 'broken.wav' }], {
      resolveFileURL: async () => 'file:///broken.wav',
      createAudio: () => element,
      timeoutMs: 3,
    })).rejects.toThrow('metadata');
    expect(element.pause).toHaveBeenCalledOnce();
    expect(element.src).toBe('');
  });

  it('任一音軌 metadata 出錯時整組音訊元素都清理', async () => {
    const session = new MediaIntakeSession();
    const elements = [];
    const work = session.materializeAudioElements([{ file: 'good.wav' }, { file: 'bad.wav' }], {
      resolveFileURL: async file => `file:///${file}`,
      createAudio: () => {
        const element = { src: '', readyState: elements.length === 0 ? 1 : 0, pause: vi.fn() };
        elements.push(element);
        return element;
      },
      timeoutMs: 100,
    });
    await vi.waitFor(() => expect(elements).toHaveLength(2));
    elements[1].onerror?.(new Error('broken codec'));
    await expect(work).rejects.toThrow('metadata');
    for (const element of elements) {
      expect(element.pause).toHaveBeenCalledOnce();
      expect(element.src).toBe('');
    }
  });

  it('disposes materialized elements when another channel URL fails', async () => {
    const session = new MediaIntakeSession();
    const token = session.begin('program.mov');
    const secondURL = deferred();
    const elements = [];
    const work = session.materializeAudioElements([{ file: 'a' }, { file: 'b' }], {
      token,
      resolveFileURL: file => file === 'a' ? Promise.resolve('file:///a') : secondURL.promise,
      createAudio: () => {
        const element = { src: '', readyState: 1, pause: vi.fn() };
        elements.push(element);
        return element;
      },
    });
    await vi.waitFor(() => expect(elements).toHaveLength(1));

    secondURL.reject(new Error('file URL denied'));

    await expect(work).rejects.toThrow('file URL denied');
    expect(elements[0].pause).toHaveBeenCalledOnce();
    expect(elements[0].src).toBe('');
  });

  it('serializes shared player launches so a newer intake cannot overlap an older one', async () => {
    const session = new MediaIntakeSession();
    const firstGate = deferred();
    const events = [];
    const firstToken = session.begin('A.mov');
    const first = session.runExclusive(firstToken, async () => {
      events.push('A:start');
      await firstGate.promise;
      events.push('A:end');
    });
    await vi.waitFor(() => expect(events).toEqual(['A:start']));

    const secondToken = session.begin('B.mov');
    const second = session.runExclusive(secondToken, async () => {
      events.push('B:start');
    });
    await Promise.resolve();
    expect(events).toEqual(['A:start']);

    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['A:start', 'A:end', 'B:start']);
  });

  it('keeps ownerless player cleanup in the same lane before the next launch', async () => {
    const session = new MediaIntakeSession();
    const cleanupGate = deferred();
    const events = [];
    session.begin('A.mov');
    session.invalidate();
    const cleanup = session.queueExclusive(async () => {
      events.push('cleanup:start');
      await cleanupGate.promise;
      events.push('cleanup:end');
    });
    const secondToken = session.begin('B.mov');
    const second = session.runExclusive(secondToken, async () => {
      events.push('B:start');
    });

    await vi.waitFor(() => expect(events).toEqual(['cleanup:start']));
    cleanupGate.resolve();
    await Promise.all([cleanup, second]);
    expect(events).toEqual(['cleanup:start', 'cleanup:end', 'B:start']);
  });

  it('cancels a shared video metadata wait without replacing another handler', async () => {
    const element = new EventTarget();
    Object.defineProperty(element, 'readyState', { configurable: true, value: 0 });
    const existingHandler = vi.fn();
    element.onloadedmetadata = existingHandler;
    let current = true;

    const result = waitForOwnedMediaMetadata(element, {
      owns: () => current,
      timeoutMs: 500,
      pollMs: 5,
    });
    current = false;

    await expect(result).resolves.toBe('cancelled');
    expect(element.onloadedmetadata).toBe(existingHandler);
  });
});
