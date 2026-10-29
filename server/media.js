'use strict';
// Video length read on the server, so the 5:00 check doesn't depend on the browser being able to
// play the file (iPhone HEVC .mov) or on what the browser reports. MP4/MOV/M4V only: the length
// is in the movie header box ('mvhd') inside 'moov'. Returns seconds, or null if it can't tell.
const fsp = require('node:fs/promises');

async function mp4Duration(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size: total } = await fh.stat();
    const head = Buffer.alloc(16);
    let pos = 0;
    for (let n = 0; pos + 8 <= total && n < 10000; n++) { // walk the top-level boxes
      await fh.read(head, 0, 16, pos);
      let size = head.readUInt32BE(0), hdr = 8;
      const type = head.toString('latin1', 4, 8);
      if (size === 1) { size = Number(head.readBigUInt64BE(8)); hdr = 16; } else if (size === 0) size = total - pos;
      if (size < hdr) return null;
      if (type === 'moov') {
        const len = Math.min(size - hdr, 64 * 1024 * 1024);
        const moov = Buffer.alloc(len);
        await fh.read(moov, 0, len, pos + hdr);
        return mvhd(moov);
      }
      pos += size;
    }
    return null;
  } catch { return null; } finally { if (fh) await fh.close().catch(() => {}); }
}

function mvhd(moov) {
  for (let p = 0; p + 8 <= moov.length;) {
    const size = moov.readUInt32BE(p), type = moov.toString('latin1', p + 4, p + 8);
    if (size < 8) return null;
    if (type === 'mvhd') {
      const b = moov.subarray(p + 8, p + size);
      const v1 = b[0] === 1;
      if (b.length < (v1 ? 32 : 20)) return null;
      const scale = b.readUInt32BE(v1 ? 20 : 12);
      const dur = v1 ? Number(b.readBigUInt64BE(24)) : b.readUInt32BE(16);
      if (!scale || dur === 0xffffffff) return null;
      const secs = dur / scale;
      return Number.isFinite(secs) && secs > 0 && secs < 36000 ? Math.round(secs * 10) / 10 : null;
    }
    p += size;
  }
  return null;
}

module.exports = { mp4Duration };
