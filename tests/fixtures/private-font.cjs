'use strict';

// Same glyphs and metrics as the bundled face, with a distinct uninstalled
// family. A system font cannot conceal failure to load the supplied font file.
function privateSarasaFont(original) {
  const bytes = Buffer.from(original), tables = [];
  for (let index = 0; index < bytes.readUInt16BE(4); index++) {
    const entry = 12 + index * 16;
    tables.push({ entry, tag: bytes.toString('ascii', entry, entry + 4),
      offset: bytes.readUInt32BE(entry + 8), length: bytes.readUInt32BE(entry + 12) });
  }
  const names = tables.find(table => table.tag === 'name');
  const head = tables.find(table => table.tag === 'head');
  if (!names || !head) throw new Error('Font fixture needs SFNT name and head tables');
  const nameBytes = bytes.subarray(names.offset, names.offset + names.length);
  let replacements = 0;
  for (const [from, to] of [
    [Buffer.from('Sarasa'), Buffer.from('Qzfont')],
    [Buffer.from('Sarasa', 'utf16le').swap16(), Buffer.from('Qzfont', 'utf16le').swap16()],
  ]) {
    for (let offset = 0; (offset = nameBytes.indexOf(from, offset)) >= 0; offset += from.length) {
      to.copy(nameBytes, offset); replacements++;
    }
  }
  if (!replacements) throw new Error('Bundled Sarasa fixture family changed');
  const checksum = buffer => {
    let sum = 0;
    for (let offset = 0; offset < buffer.length; offset += 4) {
      let word = 0;
      for (let index = 0; index < 4; index++) word = word * 256 + (buffer[offset + index] || 0);
      sum = (sum + word) >>> 0;
    }
    return sum;
  };
  bytes.writeUInt32BE(0, head.offset + 8);
  for (const table of [names, head]) {
    bytes.writeUInt32BE(checksum(bytes.subarray(table.offset, table.offset + table.length)), table.entry + 4);
  }
  bytes.writeUInt32BE((0xB1B0AFBA - checksum(bytes)) >>> 0, head.offset + 8);
  if (checksum(bytes) !== 0xB1B0AFBA) throw new Error('Private font fixture checksum mismatch');
  return { bytes, family: 'Qzfont Mono TC Nerd', postscript: 'QzfontMonoTCNerd-regular' };
}

module.exports = { privateSarasaFont };
