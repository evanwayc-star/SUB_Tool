// @subtool-ci windows
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { describe, it, expect } from 'vitest';
import { STYLE_DEFAULTS } from '../src/substyle.js';
import { SubFormats } from '../src/formats.js';
import { nativeTestTools } from './fixtures/native-tools.cjs';
import { privateSarasaFont } from './fixtures/private-font.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { ffmpeg } = nativeTestTools();
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist/electron.exe');
const FONTS = [
  ['更紗黑體', 'sarasa-mono-tc-nerd-regular.ttf', 'Sarasa Mono TC Nerd'],
  ['台北黑體', 'TaipeiSansTCBeta-Regular.ttf', 'Taipei Sans TC Beta'],
  ['思源黑體', 'NotoSansCJKtc-Regular.otf', 'Noto Sans CJK TC Regular'],
  ['思源宋體', 'NotoSerifCJKtc-Regular.otf', 'Noto Serif CJK TC'],
  ['標楷體', 'edukai-5.1_20251208.ttf', 'TW-MOE-Std-Kai'],
  ['粉圓字體', 'jf-openhuninn-2.1.ttf', 'jf-openhuninn-2.1'],
].map(([name, filename, family]) => ({ name, family, file: path.join(ROOT, 'font', name, filename) }));
const native = process.platform === 'win32' && existsSync(ffmpeg) && existsSync(ELECTRON) ? describe : describe.skip;

function bounds(rgb, width, height, textOnly = true) {
  const b = { left:width, right:-1, top:height, bottom:-1 };
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const i=(y*width+x)*3, pixel=[rgb[i],rgb[i+1],rgb[i+2]];
    if(textOnly ? Math.min(...pixel)<160 : Math.max(...pixel.map(v=>Math.abs(v-16)))<10) continue;
    b.left=Math.min(b.left,x); b.right=Math.max(b.right,x); b.top=Math.min(b.top,y); b.bottom=Math.max(b.bottom,y);
  }
  return b;
}

native('字幕預覽與 ASS 實際像素', () => {
  it('依真字型度量維持單雙行、錨點、框線、旋轉與兩種解析度的版面及自產往返', () => {
    const directory=mkdtempSync(path.join(tmpdir(),'subtool-subtitle-parity-test-'));
    try {
      const samples=[];
      const sample=(font,height,text,over={})=>samples.push({
        width:height*16/9,height,
        track:{...STYLE_DEFAULTS,font,fontSize:70,lineSpacing:1.2,posY:50,valign:'top',...over},
        cue:{id:`cue-${samples.length}`,track:0,start:0,end:2,timed:true,text},
      });
      for(const font of FONTS) for(const height of [540,1080]) {
        sample(font.name,height,'護理主管 請到二號手術室');
        sample(font.name,height,'護理主管 請到二號手術室\n好 我愛你');
      }
      for(const height of [540,1080]) {
        sample('更紗黑體',height,'護理主管 請到二號手術室\n好 我愛你',{posY:89});
        sample('更紗黑體',height,'護理主管\n好 我愛你',{outline:5,outlineColor:'#00ff00',angle:15,valign:'middle'});
        sample('台北黑體',height,'護理主管\n好 我愛你',{bgBox:true,bgColor:'#405060',bgAlpha:1,outline:3,angle:-12,valign:'bottom'});
        sample('粉圓字體',height,'護理主管\n好 我愛你',{bold:false,italic:true,align:'left',valign:'bottom'});
      }
      sample('更紗黑體',540,'護理主管\n好 我愛你');
      samples.at(-1).width=720;
      sample('更紗黑體',720,'護理主管\n好 我愛你',{posY:60});
      samples.at(-1).width=405;
      sample('更紗黑體',540,'護理主管\n好 我愛你');
      samples.at(-1).cue.style={font:'台北黑體',fontSize:94,lineSpacing:1.4,letterSpacing:3};
      mkdirSync(path.join(directory,'fonts'));
      for(const [index,font] of FONTS.entries()) copyFileSync(font.file,path.join(directory,'fonts',`${index}${path.extname(font.file)}`));
      const privateFont=privateSarasaFont(readFileSync(FONTS[0].file));
      const privatePath=path.join(directory,'fonts/0.ttf');
      writeFileSync(privatePath,privateFont.bytes);
      const fonts=FONTS.map((font,index)=>index ? font : {...font,file:privatePath,family:privateFont.family});
      writeFileSync(path.join(directory,'config.json'),JSON.stringify({fonts,samples}));
      buildSync({stdin:{contents:`import {loadFonts,effStyle,anchorPct,styleToCss} from './src/substyle.js';
        import {prepareSubtitleFileExport} from './src/subtitle-file-export.js';
        window.fixture={loadFonts,effStyle,anchorPct,styleToCss,prepareSubtitleFileExport};`,resolveDir:ROOT},
        bundle:true,platform:'browser',format:'esm',outfile:path.join(directory,'bundle.js'),logLevel:'silent'});
      writeFileSync(path.join(directory,'index.html'),`<!doctype html><style>${readFileSync(path.join(ROOT,'src/styles.css'),'utf8')}</style><div id="subtitle" class="vsub-track"><span class="line"></span></div>`);
      const render=spawnSync(ELECTRON,[path.join(ROOT,'tests/fixtures/subtitle-preview-export.cjs'),directory,'--no-sandbox'],{
        cwd:ROOT,encoding:'utf8',timeout:18000,windowsHide:true,env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'}});
      expect(render.status,render.stderr).toBe(0);
      const results=JSON.parse(readFileSync(path.join(directory,'results.json'),'utf8'));
      const ff=args=>{
        const r=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-threads','1',...args],{cwd:directory,maxBuffer:1920*1080*4});
        expect(r.status,String(r.stderr)).toBe(0); return r.stdout;
      };
      const failures=[];
      samples.forEach((s,index)=>{
        expect(results[index].fontLoaded).toBe(true);
        const ass=Buffer.from(results[index].content,'base64').toString('utf16le').replace(/^\uFEFF/,'');
        writeFileSync(path.join(directory,`${index}.ass`),ass);
        const parsed=SubFormats.parseASS(ass).subtool;
        expect(parsed.cues).toHaveLength(1);
        expect(parsed.cues[0]).toMatchObject({id:s.cue.id,text:s.cue.text,start:0,end:2});
        if(s.cue.style) expect(parsed.cues[0].style).toEqual(s.cue.style);
        expect(parsed.tracks[0]).toMatchObject(s.track);
        const actual=ff(['-f','lavfi','-i',`color=c=0x101010:s=${s.width}x${s.height}:d=1`,
          '-vf',`ass=${index}.ass:fontsdir=fonts`,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
        const preview=ff(['-i',`${index}-preview.png`,'-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
        expect(actual).toHaveLength(s.width*s.height*3); expect(preview).toHaveLength(actual.length);
        for(const textOnly of [true,false]){
          const a=bounds(actual,s.width,s.height,textOnly),p=bounds(preview,s.width,s.height,textOnly);
          const tolerance=3*s.height/540;
          if(a.right<0 || Object.keys(a).some(key=>Math.abs(a[key]-p[key])>tolerance))
            failures.push({font:s.track.font,height:s.height,text:s.cue.text,angle:s.track.angle,bg:s.track.bgBox,textOnly,preview:p,ass:a,metrics:results[index].metrics});
        }
      });
      expect(failures.map(failure=>JSON.stringify(failure))).toEqual([]);
    } finally { rmSync(directory,{recursive:true,force:true}); }
  });
});
