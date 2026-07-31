/* 字幕樣式的【跨路契約】。

   同一份生效樣式（effStyle 的結果）必須被渲染成兩種東西：
     src/substyle.js  styleToCss()          → HTML 預覽（編輯時看到的）
     src/substyle.js  styleToAssStyleLine() → ASS → mpv/libass ＋ FFmpeg 燒錄

   為什麼不合併成一份：CSS 與 ASS 是兩種本質不同的排版系統，
   字級單位（px vs pt）、外框語義（置中描邊 vs 向外擴）、旋轉方向（順時針 vs 逆時針）
   都不一樣。正確的接縫是「共用同一份生效樣式，各自渲染成自己的表達」。

   既然無法合併，就必須有機制阻止它們漂掉——就是這支測試。
   對照 tests/imageGeomContract.test.js，那是幾何側的同一種守衛；
   在 v5.9.0 之前，樣式側（也就是 §0.1 三路一致真正在講的那條）沒有任何守衛，
   styleToCss() 被 0 支測試碰到。

   【這支測什麼、不測什麼】
   測的是「兩邊對同一個樣式欄位的回應是否對應」，不是「兩邊字串相等」——
   後者永遠不可能成立。每一條斷言都對應一個具體的、會靜默壞掉的不一致。 */
import { describe, expect, it } from 'vitest';
import {
  STYLE_DEFAULTS, styleToCss, styleToAssStyleLine, hexToAssColor, ASS_PLAY_RES,
} from '../src/substyle.js';

const style = (over = {}) => ({ ...STYLE_DEFAULTS, ...over });

/* Style 行的欄位順序見 styleToAssStyleLine()：
   Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,
   Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,
   BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding */
const ASS_FIELDS = [
  'Name', 'Fontname', 'Fontsize', 'PrimaryColour', 'SecondaryColour', 'OutlineColour', 'BackColour',
  'Bold', 'Italic', 'Underline', 'StrikeOut', 'ScaleX', 'ScaleY', 'Spacing', 'Angle',
  'BorderStyle', 'Outline', 'Shadow', 'Alignment', 'MarginL', 'MarginR', 'MarginV', 'Encoding',
];
function assFields(st) {
  const line = styleToAssStyleLine('Default', st, ASS_PLAY_RES.y).replace(/^Style:\s*/, '');
  const parts = line.split(',');
  const out = {};
  ASS_FIELDS.forEach((k, i) => { out[k] = parts[i]; });
  return out;
}

/* CSS 是一串 `k:v;`，取單一屬性來比對。 */
function cssProp(css, prop) {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(css);
  return m ? m[1].trim() : null;
}

/* 樣式矩陣：涵蓋每一個兩邊都會表達的欄位，且刻意包含互斥組合（bgBox 開/關、直書開/關）。 */
const MATRIX = [
  { label: '預設', over: {} },
  { label: '大字級', over: { fontSize: 96 } },
  { label: '極小字級（CSS 有下限 12px）', over: { fontSize: 8 } },
  { label: '非白字色', over: { color: '#ffee00' } },
  { label: '不粗體', over: { bold: false } },
  { label: '斜體', over: { italic: true } },
  { label: '字距', over: { letterSpacing: 4 } },
  { label: '厚外框', over: { outline: 6, outlineColor: '#3399ff' } },
  { label: '無外框', over: { outline: 0 } },
  { label: '陰影', over: { shadow: 3 } },
  { label: '旋轉正角', over: { angle: 15 } },
  { label: '旋轉負角', over: { angle: -22.5 } },
  { label: '直書', over: { vertical: true, letterSpacing: 3 } },
  { label: '背景色塊', over: { bgBox: true, bgColor: '#101020', bgAlpha: 0.6 } },
  { label: '背景色塊＋陰影', over: { bgBox: true, shadow: 4 } },
  { label: '背景色塊＋直書', over: { bgBox: true, vertical: true } },
  { label: '上錨中對齊', over: { valign: 'top', align: 'center' } },
  { label: '中錨右對齊', over: { valign: 'middle', align: 'right' } },
  { label: '下錨左對齊', over: { valign: 'bottom', align: 'left' } },
];

describe('字幕樣式跨路契約：CSS ↔ ASS', () => {
  for (const { label, over } of MATRIX) {
    describe(label, () => {
      const st = style(over);
      const css = styleToCss(st, 1);
      const ass = assFields(st);

      /* 字級是三路一致最容易靜默壞掉的一項：libass 把 Fontsize 當 pt，
         CSS 是 px，96dpi 下 1pt = 4/3 px，所以預覽要乘 0.75 才同構。
         這個係數若被改掉，畫面看起來仍然「有字」，但匯出字級會整個不同。 */
      it('字級：CSS px = round(ASS Fontsize × 0.75)，下限 12px', () => {
        const expected = Math.max(12, Math.round(Number(ass.Fontsize) * 0.75));
        expect(cssProp(css, 'font-size')).toBe(`${expected}px`);
      });

      it('主色：CSS 十六進位 ↔ ASS &HAABBGGRR', () => {
        expect(cssProp(css, 'color')).toBe(st.color);
        expect(ass.PrimaryColour).toBe(hexToAssColor(st.color));
      });

      it('粗體／斜體：CSS 700/400 ↔ ASS 1/0', () => {
        expect(cssProp(css, 'font-weight')).toBe(st.bold ? '700' : '400');
        expect(ass.Bold).toBe(st.bold ? '1' : '0');
        expect(cssProp(css, 'font-style')).toBe(st.italic ? 'italic' : 'normal');
        expect(ass.Italic).toBe(st.italic ? '1' : '0');
      });

      /* 旋轉方向相反：CSS 順時針為正，ASS \frz 逆時針為正。
         符號寫錯的話字幕會往反方向轉，預覽與匯出各轉一邊。 */
      it('旋轉：CSS deg 與 ASS Angle 互為相反數', () => {
        const cssT = cssProp(css, 'transform');
        if (!st.angle) {
          expect(cssT).toBeNull();
          expect(Number(ass.Angle)).toBe(0);
        } else {
          expect(cssT).toBe(`rotate(${st.angle}deg)`);
          expect(Number(ass.Angle)).toBe(-st.angle);
        }
      });

      /* 直書時 ASS 是逐字拆列自己定位，Spacing 必須歸零，
         否則同一份樣式在 mpv 會多出一份字距、和預覽對不上。 */
      it('直書：CSS 走 writing-mode，ASS 的 Spacing 必須歸零', () => {
        if (st.vertical) {
          expect(cssProp(css, 'writing-mode')).toBe('vertical-lr');
          expect(cssProp(css, 'text-orientation')).toBe('upright');
          expect(Number(ass.Spacing)).toBe(0);
        } else {
          expect(cssProp(css, 'writing-mode')).toBeNull();
          expect(Number(ass.Spacing)).toBe(st.letterSpacing);
        }
      });

      /* 外框語義不同：ASS 向外擴 N，CSS 是置中描邊 → 視覺對應寬度為 2N。
         係數掉了會讓預覽的框比匯出細一半。 */
      it('外框：無背景色塊時 CSS stroke = ASS Outline × 2；有色塊時改用 BorderStyle 3', () => {
        if (st.bgBox) {
          expect(Number(ass.BorderStyle)).toBe(3);
          expect(cssProp(css, '-webkit-text-stroke')).toBeNull();
          expect(cssProp(css, 'background')).not.toBeNull();
          expect(ass.BackColour).toBe(hexToAssColor(st.bgColor, st.bgAlpha));
          expect(ass.OutlineColour).toBe(ass.BackColour);
        } else {
          expect(Number(ass.BorderStyle)).toBe(1);
          expect(cssProp(css, 'background')).toBeNull();
          expect(Number(ass.Outline)).toBe(st.outline);
          if (st.outline > 0) {
            const fs = Math.max(12, Math.round(st.fontSize * 0.75));
            expect(cssProp(css, '-webkit-text-stroke'))
              .toBe(`${(st.outline * 2).toFixed(1)}px ${st.outlineColor}`);
            expect(ass.OutlineColour).toBe(hexToAssColor(st.outlineColor));
            expect(fs).toBeGreaterThan(0);
          } else {
            expect(cssProp(css, '-webkit-text-stroke')).toBeNull();
          }
        }
      });

      /* 陰影：兩邊要嘛都有、要嘛都沒有。BorderStyle=3 時 ASS 需要 Shadow≥1
         才撐得出色塊，這是刻意的例外，一併釘住。 */
      it('陰影：兩路同時存在或同時不存在', () => {
        const hasCssShadow = cssProp(css, 'text-shadow') !== null || cssProp(css, 'box-shadow') !== null;
        if (st.bgBox) {
          expect(Number(ass.Shadow)).toBe(Math.max(1, st.shadow));
          expect(hasCssShadow).toBe(st.shadow > 0);
        } else {
          expect(Number(ass.Shadow)).toBe(st.shadow);
          expect(hasCssShadow).toBe(st.shadow > 0);
        }
      });

      it('行距：CSS line-height 直接帶生效樣式的倍數', () => {
        expect(cssProp(css, 'line-height')).toBe(String(st.lineSpacing));
      });

      /* Alignment 是 numpad：垂直基數（下1/中4/上7）＋ 水平（左0/中1/右2）。
         直書一律上錨——CSS 那邊也是靠 writing-mode 從頂端往下排。 */
      it('對齊：ASS Alignment 與生效樣式的 align／valign 對應（直書強制上錨）', () => {
        const vbase = { top: 7, middle: 4, bottom: 1 }[st.vertical ? 'top' : st.valign];
        const acol = { left: 0, center: 1, right: 2 }[st.align];
        expect(Number(ass.Alignment)).toBe(vbase + acol);
      });
    });
  }

  /* 契約的邊界：字級縮放基準是【畫面高 ÷ PlayResY】（鐵律 §0.2），
     所以 ratio 進來時只有 CSS 這一路會變——ASS 的 Fontsize 永遠是原始值，
     由 libass 依輸出高度自己等比縮放。這條防的是有人「順手」把 ratio 也乘進 ASS。 */
  it('ratio 只作用在 CSS：ASS Fontsize 不隨預覽縮放改變', () => {
    const st = style({ fontSize: 60 });
    const fontsizeAt = () => assFields(st).Fontsize;
    const before = fontsizeAt();
    expect(cssProp(styleToCss(st, 1), 'font-size')).toBe('45px');
    expect(cssProp(styleToCss(st, 0.5), 'font-size')).toBe('23px');
    expect(fontsizeAt()).toBe(before);
    expect(Number(before)).toBe(60);
  });

  it('ASS Style 行的欄位數固定為 23（欄位錯位會讓 libass 整行忽略）', () => {
    const line = styleToAssStyleLine('Default', style(), ASS_PLAY_RES.y).replace(/^Style:\s*/, '');
    expect(line.split(',')).toHaveLength(23);
  });
});
