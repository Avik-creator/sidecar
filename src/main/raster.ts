import { deflateSync } from "node:zlib";
import { MARK_ACCENT, MARK_PAPER, markLayout } from "../shared/mark.js";

const CRC_TABLE = makeCrcTable();

export function trayMarkPng(pixelSize = 32): Buffer {
  return renderOutlineMark(pixelSize, [0, 0, 0, 255]);
}

export function appIconPng(size = 512): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  fillRect(rgba, size, 0, 0, size, size, hexToRgba(MARK_PAPER));
  const glyph = Math.round(size * 0.38);
  const origin = (size - glyph) / 2;
  stampOutline(rgba, size, origin, origin, glyph, hexToRgba(MARK_ACCENT));
  return encodePng(size, size, rgba);
}

function hexToRgba(hex: string): [number, number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
    255,
  ];
}

function fillRect(
  rgba: Buffer,
  size: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  color: [number, number, number, number],
): void {
  for (let y = y0; y < y0 + height; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) {
      if (x < 0 || y < 0 || x >= size || y >= size) {
        continue;
      }
      const index = (y * size + x) * 4;
      rgba[index] = color[0];
      rgba[index + 1] = color[1];
      rgba[index + 2] = color[2];
      rgba[index + 3] = color[3];
    }
  }
}

function renderOutlineMark(size: number, color: [number, number, number, number]): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  stampOutline(rgba, size, 0, 0, size, color);
  return encodePng(size, size, rgba);
}

function stampOutline(
  rgba: Buffer,
  canvas: number,
  originX: number,
  originY: number,
  glyph: number,
  color: [number, number, number, number],
): void {
  const layout = markLayout(glyph);
  const half = layout.stroke / 2;
  for (const petal of layout.petals) {
    stampRing(rgba, canvas, originX + petal.x, originY + petal.y, petal.r, half, color);
  }
  stampCircle(rgba, canvas, originX + layout.cx, originY + layout.cy, layout.centerR, color);
}

function stampRing(
  rgba: Buffer,
  size: number,
  cx: number,
  cy: number,
  radius: number,
  halfWidth: number,
  color: [number, number, number, number],
): void {
  const pad = halfWidth + 1.5;
  const minX = Math.max(0, Math.floor(cx - radius - pad));
  const maxX = Math.min(size - 1, Math.ceil(cx + radius + pad));
  const minY = Math.max(0, Math.floor(cy - radius - pad));
  const maxY = Math.min(size - 1, Math.ceil(cy + radius + pad));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const alpha = Math.max(0, Math.min(1, halfWidth - Math.abs(distance - radius) + 0.5));
      if (alpha <= 0) {
        continue;
      }
      blend(rgba, (y * size + x) * 4, color, alpha);
    }
  }
}

function stampCircle(
  rgba: Buffer,
  size: number,
  cx: number,
  cy: number,
  radius: number,
  color: [number, number, number, number],
): void {
  const pad = 1.5;
  const minX = Math.max(0, Math.floor(cx - radius - pad));
  const maxX = Math.min(size - 1, Math.ceil(cx + radius + pad));
  const minY = Math.max(0, Math.floor(cy - radius - pad));
  const maxY = Math.min(size - 1, Math.ceil(cy + radius + pad));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const alpha = Math.max(0, Math.min(1, radius - distance + 0.5));
      if (alpha <= 0) {
        continue;
      }
      blend(rgba, (y * size + x) * 4, color, alpha);
    }
  }
}

function blend(rgba: Buffer, index: number, color: [number, number, number, number], cover: number): void {
  const srcA = (color[3] / 255) * cover;
  const dstA = (rgba[index + 3] ?? 0) / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) {
    return;
  }
  const dstR = rgba[index] ?? 0;
  const dstG = rgba[index + 1] ?? 0;
  const dstB = rgba[index + 2] ?? 0;
  rgba[index] = Math.round((color[0] * srcA + dstR * dstA * (1 - srcA)) / outA);
  rgba[index + 1] = Math.round((color[1] * srcA + dstG * dstA * (1 - srcA)) / outA);
  rgba[index + 2] = Math.round((color[2] * srcA + dstB * dstA * (1 - srcA)) / outA);
  rgba[index + 3] = Math.round(outA * 255);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ];
  return Buffer.concat(chunks);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuf.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc, 8 + data.length);
  return chunk;
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
}

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ (buffer[i] ?? 0)) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
