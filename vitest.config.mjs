import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { windowsTestFiles } from './scripts/ci/test-groups.mjs';

const windowsTests = windowsTestFiles(fileURLToPath(new URL('./', import.meta.url)));

/* ==============================================================================
   SUB Tool — Vitest 單元與整合測試配置
   ==============================================================================
   - 獨立於 vite.config.mjs：測試不需要 singlefile 打包外掛。
   - 預設 node 環境（純函式）；需要 DOM 的測試檔自行於檔頭加 // @vitest-environment jsdom。
   - portable 測試保持並行；桌面／native 群接續獨占執行，與 Windows CI 同源。
     獨立 profile 不隔離 OS 焦點與可見繪製；跨程序遮擋會讓 CDP 滾輪等待 paint。
   - testTimeout / hookTimeout 維持 30000ms，不以延長期限掩蓋共享資源競爭。
   ============================================================================== */
export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    projects: [
      {
        extends: true,
        test: {
          name: 'portable',
          include: ['tests/**/*.test.js'],
          exclude: windowsTests,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'windows-native',
          include: windowsTests,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});

