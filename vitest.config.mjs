import { defineConfig } from 'vitest/config';

/* ==============================================================================
   SUB Tool — Vitest 單元與整合測試配置
   ==============================================================================
   - 獨立於 vite.config.mjs：測試不需要 singlefile 打包外掛。
   - 預設 node 環境（純函式）；需要 DOM 的測試檔自行於檔頭加 // @vitest-environment jsdom。
   - 配置 30000ms 全局逾時（testTimeout / hookTimeout）：
     專案包含 168+ 個測試檔案與真實 Electron/CDP 程序啟動測試；
     在本地多工作執行緒（Multi-workers）高速並行時，適當的防抖裕度可徹底防範
     高負載下的 I/O 尖峰假性超時。
   ============================================================================== */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});

