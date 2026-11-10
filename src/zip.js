'use strict';
// Reading zip archives (jars and modpacks are zips). `bad(why)` builds the error to throw,
// so each caller can word it for the kind of file it is reading.

const fs = require('fs');
const zlib = require('zlib');
const { ApiError } = require('./http');

const MAX_ENTRIES = 50000;
const damaged = (why) => new ApiError(`An archive cannot be read: ${why}.`, 'BAD_ARCHIVE');

// A minimal zip reader (stored and deflated entries, no zip64, no encryption).
function openZip(file, bad = damaged, MAX_ENTRY = 512 * 2 ** 20) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 65557));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { at = i; break; }
    if (at < 0) throw bad('it is not a zip archive');
    const count = tail.readUInt16LE(at + 10), dirSize = tail.readUInt32LE(at + 12), dirOffset = tail.readUInt32LE(at + 16);
    if (dirOffset === 0xffffffff || count === 0xffff) throw bad('it is larger than Modion can read');
    if (count > MAX_ENTRIES || dirOffset + dirSize > size) throw bad('its file list is damaged');
    const dir = Buffer.alloc(dirSize);
    fs.readSync(fd, dir, 0, dirSize, dirOffset);
    const entries = new Map();
    for (let p = 0, n = 0; n < count; n++) {
      if (p + 46 > dir.length || dir.readUInt32LE(p) !== 0x02014b50) throw bad('its file list is damaged');
      const nameLen = dir.readUInt16LE(p + 28), extraLen = dir.readUInt16LE(p + 30), commentLen = dir.readUInt16LE(p + 32);
      const name = dir.toString('utf8', p + 46, p + 46 + nameLen);
      entries.set(name, {
        name,
        encrypted: Boolean(dir.readUInt16LE(p + 8) & 1),
        method: dir.readUInt16LE(p + 10),
        packed: dir.readUInt32LE(p + 20),
        size: dir.readUInt32LE(p + 24),
        offset: dir.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    const read = (entry) => {
      if (entry.encrypted) throw bad('it is password-protected');
      if (entry.size > MAX_ENTRY || entry.packed > MAX_ENTRY) throw bad(`${entry.name.slice(0, 80)} is too large`);
      const head = Buffer.alloc(30);
      fs.readSync(fd, head, 0, 30, entry.offset);
      if (head.readUInt32LE(0) !== 0x04034b50) throw bad('it is damaged');
      const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      const data = Buffer.alloc(entry.packed);
      fs.readSync(fd, data, 0, entry.packed, start);
      if (entry.method === 0) return data;
      if (entry.method !== 8) throw bad('it uses a compression method Modion cannot read');
      try {
        return zlib.inflateRawSync(data, { maxOutputLength: Math.min(entry.size + 1024, MAX_ENTRY) });
      } catch {
        throw bad(`${entry.name.slice(0, 80)} is damaged`);
      }
    };
    return { entries, read, close: () => fs.closeSync(fd) };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

// Writes a zip archive from { name, data } entries (deflated, no zip64).
function writeZip(file, entries) {
  const fd = fs.openSync(file, 'w');
  try {
    const central = [];
    let offset = 0;
    for (const { name, data } of entries) {
      const nameBuf = Buffer.from(name, 'utf8');
      const packed = zlib.deflateRawSync(data);
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0);
      head.writeUInt16LE(20, 4);        // version needed
      head.writeUInt16LE(0x0800, 6);    // names are UTF-8
      head.writeUInt16LE(8, 8);         // deflate
      head.writeUInt32LE(0x00210000, 10); // a fixed date (1980-01-01), so the same input gives the same file
      head.writeUInt32LE(zlib.crc32(data), 14);
      head.writeUInt32LE(packed.length, 18);
      head.writeUInt32LE(data.length, 22);
      head.writeUInt16LE(nameBuf.length, 26);
      fs.writeSync(fd, Buffer.concat([head, nameBuf, packed]));
      const dir = Buffer.alloc(46);
      dir.writeUInt32LE(0x02014b50, 0);
      dir.writeUInt16LE(20, 4);
      head.copy(dir, 6, 4, 30);         // same fields as the local header, from "version needed" on
      dir.writeUInt32LE(offset, 42);
      central.push(dir, nameBuf);
      offset += 30 + nameBuf.length + packed.length;
    }
    const dirBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length / 2, 8);
    end.writeUInt16LE(central.length / 2, 10);
    end.writeUInt32LE(dirBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    fs.writeSync(fd, Buffer.concat([dirBuf, end]));
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { openZip, writeZip };
