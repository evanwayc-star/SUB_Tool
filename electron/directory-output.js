'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isPathContained } = require('./file-authority');

// Native picker authority stays in main. This module owns the complete filesystem
// operation for both style bundles and subtitle batches, including publication.
function writeDirectoryFiles(directory, files, { fsModule = fs, randomUUID = crypto.randomUUID } = {}) {
  const root = fsModule.realpathSync(directory);
  const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
  const rootOwner = fsModule.lstatSync(root);
  if (!rootOwner.isDirectory() || rootOwner.isSymbolicLink()) throw new Error('匯出目錄不是實體資料夾');

  const unsafe = () => Object.assign(new Error('匯出路徑超出所選實體目錄或包含連結'), { code: 'UNSAFE_DIRECTORY_OUTPUT' });
  const statIfPresent = file => {
    try { return fsModule.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const checkParents = parents => {
    for (const parent of parents) {
      const current = statIfPresent(parent.file);
      if (!current || !current.isDirectory() || current.isSymbolicLink() || !sameFile(current, parent.owner)) throw unsafe();
      if (!isPathContained(root, fsModule.realpathSync(parent.file))) throw unsafe();
    }
  };
  const prepareParents = target => {
    const parents = [{ file: root, owner: rootOwner }];
    let current = root;
    const relative = path.relative(root, path.dirname(target));
    for (const segment of relative ? relative.split(path.sep) : []) {
      checkParents(parents);
      current = path.join(current, segment);
      let owner = statIfPresent(current);
      if (!owner) {
        try { fsModule.mkdirSync(current); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        owner = statIfPresent(current);
      }
      if (!owner || !owner.isDirectory() || owner.isSymbolicLink()) throw unsafe();
      parents.push({ file: current, owner });
    }
    checkParents(parents);
    return parents;
  };
  const checkTarget = target => {
    const existing = statIfPresent(target);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw unsafe();
  };

  let written = 0, blocked = 0;
  for (const entry of Array.isArray(files) ? files : []) {
    const data = entry && (entry.content || entry.b64);
    if (!entry || typeof entry.name !== 'string' || !entry.name || typeof data !== 'string' || !data) continue;
    const target = path.resolve(root, entry.name);
    if (target === root || !isPathContained(root, entry.name)
      || (process.platform === 'win32' && path.relative(root, target).includes(':'))) {
      blocked++;
      continue;
    }
    let temporary = null, descriptor = null, temporaryOwner = null;
    try {
      const parents = prepareParents(target);
      checkTarget(target);
      // Stage at the picked root, so a replaced nested parent cannot strand the
      // private file or redirect writes. The final rename replaces the selected
      // name rather than truncating the inode behind an existing hardlink.
      temporary = path.join(root, `.directory-output-${randomUUID()}.tmp`);
      descriptor = fsModule.openSync(temporary, 'wx');
      temporaryOwner = fsModule.fstatSync(descriptor);
      fsModule.writeFileSync(descriptor, Buffer.from(data, 'base64'));
      fsModule.fsyncSync(descriptor);
      fsModule.closeSync(descriptor);
      descriptor = null;
      checkParents(parents);
      checkTarget(target);
      const current = statIfPresent(temporary);
      if (!current || !current.isFile() || current.isSymbolicLink() || !sameFile(current, temporaryOwner)) throw unsafe();
      fsModule.renameSync(temporary, target);
      temporary = null;
      written++;
    } catch (error) {
      if (error.code !== 'UNSAFE_DIRECTORY_OUTPUT') throw error;
      blocked++;
    } finally {
      if (descriptor !== null) {
        if (!temporaryOwner) {
          try { temporaryOwner = fsModule.fstatSync(descriptor); } catch (error) {}
        }
        // Retain the first operation error while still closing the owned handle.
        try { fsModule.closeSync(descriptor); } catch (error) {}
      }
      if (temporary && temporaryOwner) {
        const current = statIfPresent(temporary);
        if (current && !current.isSymbolicLink() && sameFile(current, temporaryOwner)) fsModule.unlinkSync(temporary);
      }
    }
  }
  return { written, blocked };
}

module.exports = { writeDirectoryFiles };
