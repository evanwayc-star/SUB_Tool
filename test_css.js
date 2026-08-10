import { styleToCss, effStyle } from './src/substyle.js';
const st = effStyle({ style: { bgBox: true, bgColor: '#ff0000', bgAlpha: 0.8, shadow: 2 } });
console.log(styleToCss(st));
