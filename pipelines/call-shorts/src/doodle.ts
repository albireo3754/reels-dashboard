/**
 * mock 이미지 — 의존성 없이 '삐뚤빼뚤 손그림' 자리표시 PNG를 그립니다.
 *
 * 실생성 모델을 부를 수 없는 dry-run·테스트에서 렌더가 끝까지 돌도록 컷 수만큼 9:16 이미지를 만듭니다.
 * 스타일 가이드(미색 종이+그레인, 두꺼운 삐뚤한 검정 선, 핑크/하늘색 액센트)를 최소한으로 흉내 냅니다.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

type RGB = [number, number, number];

const PAPER: RGB = [253, 249, 242];
const INK: RGB = [26, 26, 26];
const GIRL: RGB = [255, 107, 157];
const BOY: RGB = [79, 195, 247];
const SOFT: RGB = [232, 226, 214];

class Canvas {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;

  constructor(width: number, height: number, background: RGB = PAPER) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 3);
    for (let index = 0; index < width * height; index += 1) {
      this.pixels[index * 3] = background[0];
      this.pixels[index * 3 + 1] = background[1];
      this.pixels[index * 3 + 2] = background[2];
    }
  }

  private put(x: number, y: number, color: RGB): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = (y * this.width + x) * 3;
    this.pixels[index] = color[0];
    this.pixels[index + 1] = color[1];
    this.pixels[index + 2] = color[2];
  }

  grain(seed: number, amount = 7): void {
    let state = seed >>> 0;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0xffffffff;
    };
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        if (random() < 0.26) {
          const delta = Math.trunc(random() * (amount * 2 + 1)) - amount;
          const index = (y * this.width + x) * 3;
          for (let offset = 0; offset < 3; offset += 1) {
            const value = this.pixels[index + offset] + delta;
            this.pixels[index + offset] = value < 0 ? 0 : value > 255 ? 255 : value;
          }
        }
      }
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, color: RGB, options: { width?: number; fill?: boolean; wobble?: number; seed?: number } = {}): void {
    const lineWidth = options.width ?? 5;
    const wobble = options.wobble ?? 0.035;
    const seed = options.seed ?? 1;
    const tolerance = lineWidth / Math.max(6, Math.min(rx, ry));
    const x0 = Math.max(0, Math.floor(cx - rx - lineWidth - 2));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + rx + lineWidth + 2));
    const y0 = Math.max(0, Math.floor(cy - ry - lineWidth - 2));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + ry + lineWidth + 2));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const theta = Math.atan2(dy, dx);
        const scale = 1 + wobble * Math.sin(3 * theta + seed) + wobble * 0.5 * Math.sin(7 * theta + seed * 1.7);
        const distance = Math.hypot(dx, dy) / scale;
        if (options.fill && distance < 1 - tolerance) this.put(x, y, color);
        else if (Math.abs(distance - 1) <= tolerance) this.put(x, y, color);
      }
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, color: RGB, options: { width?: number; wobble?: number; seed?: number } = {}): void {
    const thickness = Math.max(1, Math.round(options.width ?? 5));
    const wobble = options.wobble ?? 1.4;
    const seed = options.seed ?? 3;
    const length = Math.max(0.001, Math.hypot(x1 - x0, y1 - y0));
    const steps = Math.trunc(length * 2);
    const phase = (seed * 0.618) % 6.28;
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const offset = wobble * Math.sin(t * 6.28 * 2.2 + phase);
      const nx = -(y1 - y0) / length;
      const ny = (x1 - x0) / length;
      const cx = x0 + (x1 - x0) * t + nx * offset;
      const cy = y0 + (y1 - y0) * t + ny * offset;
      for (let ox = -Math.floor(thickness / 2); ox <= Math.floor(thickness / 2); ox += 1) {
        for (let oy = -Math.floor(thickness / 2); oy <= Math.floor(thickness / 2); oy += 1) {
          if (ox * ox + oy * oy <= (thickness / 2 + 0.5) ** 2) this.put(Math.trunc(cx) + ox, Math.trunc(cy) + oy, color);
        }
      }
    }
  }

  rect(x0: number, y0: number, x1: number, y1: number, color: RGB, options: { fill?: boolean; width?: number } = {}): void {
    if (options.fill !== false) {
      for (let y = Math.max(0, y0); y < Math.min(this.height, y1); y += 1) {
        for (let x = Math.max(0, x0); x < Math.min(this.width, x1); x += 1) this.put(x, y, color);
      }
      return;
    }
    const width = options.width ?? 4;
    this.line(x0, y0, x1, y0, color, { width });
    this.line(x1, y0, x1, y1, color, { width });
    this.line(x1, y1, x0, y1, color, { width });
    this.line(x0, y1, x0, y0, color, { width });
  }

  toPng(): Buffer {
    const stride = this.width * 3;
    const raw = Buffer.alloc((stride + 1) * this.height);
    for (let y = 0; y < this.height; y += 1) {
      raw[y * (stride + 1)] = 0;
      Buffer.from(this.pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
    }
    const compressed = deflateSync(raw, { level: 6 });
    const chunk = (tag: string, payload: Buffer): Buffer => {
      const body = Buffer.concat([Buffer.from(tag, "ascii"), payload]);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(payload.length, 0);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body), 0);
      return Buffer.concat([length, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", compressed),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

let crcTable: Uint32Array | null = null;
function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function drawGirl(canvas: Canvas, cx: number, cy: number, scale: number, seed: number, mood: string): void {
  const head = 92 * scale;
  canvas.ellipse(cx, cy, head * 1.08, head, INK, { width: 6 * scale, fill: true, seed });
  canvas.ellipse(cx, cy + 6 * scale, head * 0.92, head * 0.82, PAPER, { width: 0, fill: true, seed: seed + 2 });
  canvas.line(cx - head, cy - head * 0.1, cx - head * 1.05, cy + head * 0.9, INK, { width: 6 * scale, seed: seed + 3 });
  canvas.line(cx + head, cy - head * 0.1, cx + head * 1.05, cy + head * 0.9, INK, { width: 6 * scale, seed: seed + 4 });
  canvas.ellipse(cx - head * 0.36, cy - head * 0.05, 7 * scale, 7 * scale, INK, { width: 0, fill: true, seed: seed + 5 });
  canvas.ellipse(cx + head * 0.36, cy - head * 0.05, 7 * scale, 7 * scale, INK, { width: 0, fill: true, seed: seed + 6 });
  if (mood === "annoyed") {
    canvas.line(cx - 16 * scale, cy + head * 0.42, cx + 16 * scale, cy + head * 0.42, INK, { width: 5 * scale, seed: seed + 7 });
  } else {
    canvas.ellipse(cx, cy + head * 0.42, 15 * scale, 9 * scale, INK, { width: 4 * scale, wobble: 0.08, seed: seed + 7 });
  }
  canvas.ellipse(cx - head * 0.85, cy - head * 0.72, 13 * scale, 8 * scale, GIRL, { width: 0, fill: true, seed: seed + 8 });
  canvas.line(cx, cy + head * 0.95, cx, cy + head * 2.4, INK, { width: 8 * scale, seed: seed + 9 });
  canvas.line(cx, cy + head * 1.3, cx - head * 0.7, cy + head * 1.9, INK, { width: 6 * scale, seed: seed + 10 });
  canvas.line(cx, cy + head * 1.3, cx + head * 0.7, cy + head * 1.9, INK, { width: 6 * scale, seed: seed + 11 });
}

function drawBoy(canvas: Canvas, cx: number, cy: number, scale: number, seed: number, mood: string): void {
  const head = 86 * scale;
  canvas.ellipse(cx, cy, head, head * 1.02, INK, { width: 6 * scale, fill: true, seed });
  canvas.ellipse(cx, cy + 6 * scale, head * 0.9, head * 0.84, PAPER, { width: 0, fill: true, seed: seed + 2 });
  canvas.ellipse(cx - head * 0.38, cy - head * 0.02, 24 * scale, 22 * scale, INK, { width: 5 * scale, seed: seed + 3 });
  canvas.ellipse(cx + head * 0.38, cy - head * 0.02, 24 * scale, 22 * scale, INK, { width: 5 * scale, seed: seed + 4 });
  canvas.line(cx - head * 0.14, cy, cx + head * 0.14, cy, INK, { width: 4 * scale, seed: seed + 5 });
  canvas.ellipse(cx - head * 0.38, cy, 5 * scale, 5 * scale, INK, { width: 0, fill: true, seed: seed + 6 });
  canvas.ellipse(cx + head * 0.38, cy, 5 * scale, 5 * scale, INK, { width: 0, fill: true, seed: seed + 7 });
  if (mood === "guilty") {
    canvas.line(cx - 18 * scale, cy + head * 0.44, cx + 18 * scale, cy + head * 0.36, INK, { width: 5 * scale, seed: seed + 8 });
    canvas.ellipse(cx + head * 0.95, cy - head * 0.45, 6 * scale, 11 * scale, BOY, { width: 0, fill: true, seed: seed + 9 });
  } else {
    canvas.line(cx - 16 * scale, cy + head * 0.42, cx + 16 * scale, cy + head * 0.42, INK, { width: 5 * scale, seed: seed + 8 });
  }
  canvas.line(cx, cy + head, cx, cy + head * 2.4, INK, { width: 8 * scale, seed: seed + 10 });
  canvas.line(cx, cy + head * 1.35, cx - head * 0.7, cy + head * 1.9, INK, { width: 6 * scale, seed: seed + 11 });
  canvas.line(cx, cy + head * 1.35, cx + head * 0.7, cy + head * 1.9, INK, { width: 6 * scale, seed: seed + 12 });
}

export function renderDoodleCut(
  dest: string,
  index: number,
  options: { width?: number; height?: number; emotion?: string } = {},
): string {
  const width = options.width ?? 720;
  const height = options.height ?? 1280;
  const canvas = new Canvas(width, height, PAPER);
  canvas.grain(1000 + index * 17);
  const scale = width / 720;
  const mood = /짜증|화|배신|annoy|angry/i.test(options.emotion ?? "") ? "annoyed" : "neutral";
  drawGirl(canvas, width * 0.36, height * 0.36, scale * 0.95, 100 + index * 7, mood);
  drawBoy(canvas, width * 0.64, height * 0.42, scale * 0.95, 500 + index * 5, index % 2 ? "guilty" : mood);
  if (index % 3 === 0) {
    canvas.ellipse(width * 0.5, height * 0.24, 16 * scale, 40 * scale, INK, { width: 4 * scale, seed: index });
    canvas.ellipse(width * 0.5, height * 0.24 + 60 * scale, 7 * scale, 7 * scale, INK, { width: 3 * scale, fill: true, seed: index + 1 });
  }
  canvas.line(width * 0.08, height * 0.74, width * 0.92, height * 0.745, INK, { width: 5 * scale, wobble: 3, seed: index + 4 });
  for (let tick = 0; tick < index; tick += 1) {
    canvas.rect(
      Math.trunc(width * 0.06 + tick * 14 * scale),
      Math.trunc(height * 0.05),
      Math.trunc(width * 0.06 + (tick + 1) * 12 * scale),
      Math.trunc(height * 0.05 + 6 * scale),
      SOFT,
    );
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, canvas.toPng());
  return dest;
}

export function renderCharacterSheet(dest: string, options: { width?: number; height?: number; variant?: number } = {}): string {
  const width = options.width ?? 900;
  const height = options.height ?? 900;
  const variant = options.variant ?? 0;
  const canvas = new Canvas(width, height, PAPER);
  canvas.grain(42 + variant);
  const cellW = Math.floor(width / 3);
  const cellH = Math.floor(height / 2);
  const moods = ["neutral", "annoyed", "guilty"];
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const cx = cellW * col + cellW / 2;
      const cy = cellH * row + cellH * 0.52;
      const seed = 100 + row * 10 + col + variant * 37;
      if (row === 0) drawGirl(canvas, cx, cy, 0.62, seed, moods[col]);
      else drawBoy(canvas, cx, cy, 0.62, seed, moods[col]);
      canvas.rect(cellW * col + 8, cellH * row + 8, cellW * (col + 1) - 8, cellH * (row + 1) - 8, SOFT, { fill: false, width: 3 });
    }
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, canvas.toPng());
  return dest;
}
