import { defineConfig } from 'vitest/config';

// 獨立於 vite.config.mjs：測試不需要 singlefile 打包外掛。
// 預設 node 環境（純函式）；需要 DOM 的測試檔自行於檔頭加
//   // @vitest-environment jsdom
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
