import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

describe('preview working-set public CLI admission',()=>{
  it.each(['missing','directory','nonexistent'])('rejects %s input before allocating a profile or spawning Electron',kind=>{
    const root=mkdtempSync(path.join(tmpdir(),'subtool-preview-cli-test-'));
    const marker=path.join(root,'side-effects.log');
    const preload=path.join(root,'guard.cjs');
    writeFileSync(preload,`const fs=require('node:fs');const cp=require('node:child_process');
      const allocate=fs.mkdtempSync;fs.mkdtempSync=(...args)=>{fs.appendFileSync(${JSON.stringify(marker)},'profile\\n');return allocate(...args);};
      cp.spawn=()=>{fs.appendFileSync(${JSON.stringify(marker)},'spawn\\n');throw new Error('Electron must not launch');};`);
    try{
      const input=kind==='missing'?[]:[kind==='directory'?process.cwd():path.join(root,'missing.mp4')];
      const result=spawnSync(process.execPath,['--require',preload,'scripts/acceptance/verify-preview-working-set.js',...input],{
        cwd:process.cwd(),encoding:'utf8',timeout:10000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('請提供一支可讀取的短 MP4');
      expect(existsSync(marker)?readFileSync(marker,'utf8'):'').toBe('');
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
