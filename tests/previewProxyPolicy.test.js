import { describe, expect, it } from 'vitest';
import { autoBuildPreviewProxy } from '../src/preview-proxy-policy.js';

describe('first-video preview proxy policy', () => {
  it('大型 Canopus HQ AVI 以 mpv 直接監看，不在匯入時重編完整長片', () => {
    expect(autoBuildPreviewProxy({codec:'hq_hqa',extension:'avi',size:116_524_384_242})).toBe(false);
  });

  it('其他格式與小型 AVI 維持現有 Proxy 預覽能力', () => {
    expect(autoBuildPreviewProxy({codec:'hq_hqa',extension:'avi',size:1024 ** 3})).toBe(true);
    expect(autoBuildPreviewProxy({codec:'h264',extension:'avi',size:116_524_384_242})).toBe(true);
    expect(autoBuildPreviewProxy({codec:'hq_hqa',extension:'mov',size:116_524_384_242})).toBe(true);
  });
});
