'use strict';
// Wraps a PNG (up to 256x256) as a Windows .ico file:   node dev/make-ico.js in.png out.ico
// Windows accepts a PNG stored inside an .ico as it is, so no image conversion is needed.
const fs = require('fs');

const [, , input, output] = process.argv;
if (!input || !output) { console.error('usage: node dev/make-ico.js in.png out.ico'); process.exit(1); }
const png = fs.readFileSync(input);
if (png.readUInt32BE(0) !== 0x89504e47) { console.error(`${input} is not a PNG`); process.exit(1); }
const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
if (width > 256 || height > 256) { console.error('the PNG must be 256x256 or smaller'); process.exit(1); }

const head = Buffer.alloc(22);
head.writeUInt16LE(1, 2);                 // type: icon
head.writeUInt16LE(1, 4);                 // one image
head.writeUInt8(width === 256 ? 0 : width, 6);
head.writeUInt8(height === 256 ? 0 : height, 7);
head.writeUInt16LE(1, 10);                // colour planes
head.writeUInt16LE(32, 12);               // bits per pixel
head.writeUInt32LE(png.length, 14);
head.writeUInt32LE(22, 18);               // where the image starts
fs.writeFileSync(output, Buffer.concat([head, png]));
