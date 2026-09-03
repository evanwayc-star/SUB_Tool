// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindPlayerFullscreen } from '../src/media-player-adapter.js';

describe('播放器雙擊全螢幕', () => {
  let player;
  let activeFullscreenElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="videoWrap"></div>';
    player = document.getElementById('videoWrap');
    activeFullscreenElement = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => activeFullscreenElement,
    });
    player.requestFullscreen = vi.fn(async () => {
      activeFullscreenElement = player;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    document.exitFullscreen = vi.fn(async () => {
      activeFullscreenElement = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
  });

  it('左鍵雙擊第一次進入、第二次退出全螢幕', async () => {
    const onChange = vi.fn();
    bindPlayerFullscreen({ element: player, documentTarget: document, onChange });

    const enterEvent = new MouseEvent('dblclick', { bubbles: true, button: 0, cancelable: true });
    player.dispatchEvent(enterEvent);
    await vi.waitFor(() => expect(player.requestFullscreen).toHaveBeenCalledOnce());
    expect(enterEvent.defaultPrevented).toBe(true);
    expect(activeFullscreenElement).toBe(player);
    expect(onChange).toHaveBeenLastCalledWith(true);

    player.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0, cancelable: true }));
    await vi.waitFor(() => expect(document.exitFullscreen).toHaveBeenCalledOnce());
    expect(activeFullscreenElement).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('右鍵雙擊不會切換全螢幕', async () => {
    bindPlayerFullscreen({ element: player, documentTarget: document });

    player.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 2, cancelable: true }));
    await Promise.resolve();

    expect(player.requestFullscreen).not.toHaveBeenCalled();
    expect(document.exitFullscreen).not.toHaveBeenCalled();
  });

  it('解除綁定後不再響應雙擊', async () => {
    const controller = bindPlayerFullscreen({ element: player, documentTarget: document });
    controller.dispose();

    player.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0, cancelable: true }));
    await Promise.resolve();

    expect(player.requestFullscreen).not.toHaveBeenCalled();
  });
});
