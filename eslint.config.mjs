import globals from 'globals';

// 僅用於開發期靜態檢查跨模組漏匯入（no-undef）。
export default [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, structuredClone: 'readonly', __APP_VERSION__: 'readonly' },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'off',
    },
  },
];
