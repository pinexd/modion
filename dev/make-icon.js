'use strict';
// Writes assets/icon.png (a 256px grass-block face) with no dependencies: node dev/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let seed = 3;
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const DIRT = [0x866043, 0x866043, 0x79553a, 0x79553a, 0x966c4a, 0x593d29, 0xb9855c, 0x6d6d6d];
const GRASS = [0x5d9c3a, 0x6aaa41, 0x528b33, 0x74b548];
const pick = (list) => list[Math.floor(rnd() * list.length)];

const cells = [];
for (let y = 0; y < 16; y++) {
  for (let x = 0; x < 16; x++) {
    cells.push(y < 3 || (y === 3 && rnd() < 0.6) || (y === 4 && rnd() < 0.25) ? pick(GRASS) : pick(DIRT));
  }
}

const SIZE = 256, SCALE = SIZE / 16;
const raw = Buffer.alloc((SIZE * 3 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 3 + 1);
  for (let x = 0; x < SIZE; x++) {
    const c = cells[Math.floor(y / SCALE) * 16 + Math.floor(x / SCALE)];
    raw.writeUIntBE(c, row + 1 + x * 3, 3);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), body.length + 4);
  return out;
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 2;

const file = path.join(__dirname, '..', 'assets', 'icon.png');
fs.writeFileSync(file, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]));
console.log('wrote', file);
