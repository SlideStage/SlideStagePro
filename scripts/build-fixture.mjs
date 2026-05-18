#!/usr/bin/env node
/**
 * Builds a sample 4-page .stage package for local development + tests.
 * Output: fixtures/out/sample.stage (zip).
 *
 * The package follows slidestage@1.0 spec verbatim:
 *   manifest.json, slides/01..04.html, thumbnails/01..04.png, speaker-notes.json.
 *
 * This script is dependency-free: it builds the ZIP itself using a stripped
 * down implementation of the PKZip "stored" + "deflate" formats. We use the
 * stdlib zlib for deflate so authenticity is fine.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'fixtures', 'out');
const OUT_FILE = path.join(OUT_DIR, 'sample.stage');

const NOW_ISO = '2026-04-29T11:54:00.000Z';
const DECK_ID = 'sample-stage-a';

/* ------------------------------ Slide HTML ------------------------------ */

const COMMON_STYLE = `
  <style>
    html, body { margin: 0; padding: 0; }
    body {
      width: 1920px; height: 1080px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue",
                   "Noto Sans CJK SC", Arial, sans-serif;
      color: #1A1A1A;
      background: #FAFAFA;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 32px;
      box-sizing: border-box;
      padding: 96px;
    }
    h1 { font-size: 96px; margin: 0; letter-spacing: -0.02em; }
    h2 { font-size: 64px; margin: 0; color: #C04A1A; }
    p, li { font-size: 36px; line-height: 1.5; max-width: 1500px; }
    .accent { color: #C04A1A; }
    ul { list-style: square; padding-left: 1.2em; }
    .slide-mark {
      position: absolute; bottom: 40px; right: 60px;
      font-family: ui-monospace, SFMono-Regular, monospace;
      color: #999; font-size: 24px;
    }
  </style>`;

function slideHtml(idx, body) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>Slide ${idx}</title>
  ${COMMON_STYLE}
</head>
<body>
  ${body}
  <div class="slide-mark">Slide ${idx} / 4 · sample-stage-a</div>
</body>
</html>`;
}

const SLIDES = [
  {
    id: 'cover',
    label: '封面',
    html: slideHtml(
      1,
      `<h2>slidestage Platform</h2>
       <h1>Slide Deck Packaging Demo</h1>
       <p class="accent">Stage A · MVP fixture · 4 pages</p>`,
    ),
    notes: '欢迎大家。今天我们要演示 .stage 格式的最小测试包。',
  },
  {
    id: 'agenda',
    label: '议程',
    html: slideHtml(
      2,
      `<h2 class="accent">本次演讲议程</h2>
       <ul>
         <li>什么是 .stage 格式</li>
         <li>平台 runtime 的能力契约</li>
         <li>Stage A MVP 的演示</li>
       </ul>`,
    ),
    notes: '这一页讲三个要点。控制时间不超过 5 分钟。',
  },
  {
    id: 'data',
    label: '数据',
    html: slideHtml(
      3,
      `<h2>关键数据</h2>
       <p>包大小 <strong>200 MB</strong>，单页 ≤ 5 MB，逻辑画布 <strong>1920×1080</strong>。</p>
       <p>已支持工具：键盘导航、Overview、Speaker view。</p>`,
    ),
    notes: null,
  },
  {
    id: 'closing',
    label: '总结',
    html: slideHtml(
      4,
      `<h1>谢谢观看</h1>
       <p class="muted">按 <strong>O</strong> 看 Overview，按 <strong>S</strong> 进 Speaker view。</p>`,
    ),
    notes: '邀请提问。',
  },
];

/* ------------------------------ Thumbnails ------------------------------ */

/**
 * Generates a tiny but valid PNG (single-color 16:9 thumbnail) without any
 * external dependencies. Uses a 32×18 RGBA bitmap deflated into IDAT.
 */
function generateThumbnailPng(idx) {
  const colors = [
    [192, 74, 26], // #C04A1A
    [78, 161, 255], // #4EA1FF
    [78, 201, 122], // #4EC97A
    [229, 72, 72], // #E54848
  ];
  const [r, g, b] = colors[(idx - 1) % colors.length];
  const W = 32;
  const H = 18;
  // Build the raw image with a per-row filter byte (filter 0 = none).
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    const rowOffset = y * (W * 4 + 1);
    raw[rowOffset] = 0;
    for (let x = 0; x < W; x++) {
      const px = rowOffset + 1 + x * 4;
      // Add a soft gradient so each thumbnail looks slightly different.
      const t = (x + y) / (W + H);
      raw[px] = Math.round(r * (0.7 + 0.3 * t));
      raw[px + 1] = Math.round(g * (0.7 + 0.3 * t));
      raw[px + 2] = Math.round(b * (0.7 + 0.3 * t));
      raw[px + 3] = 255;
    }
  }
  const deflated = zlib.deflateSync(raw);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    const crcVal = crcCompute(Buffer.concat([typeBuf, data]));
    crc.writeUInt32BE(crcVal >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflated),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crcCompute(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ----------------------------- Manifest build ---------------------------- */

function buildManifest() {
  const slides = SLIDES.map((s, i) => ({
    index: i + 1,
    id: s.id,
    label: s.label,
    file: `slides/${String(i + 1).padStart(2, '0')}-${s.id}.html`,
    thumbnail: `thumbnails/${String(i + 1).padStart(2, '0')}.png`,
    notes: s.notes,
  }));
  return {
    schema: 'slidestage@1.0',
    id: DECK_ID,
    version: '1.0.0',
    title: 'Slide Deck Packaging Demo',
    subtitle: 'Stage A MVP fixture',
    author: 'slidestage-platform',
    description: 'A four-page sample used for end-to-end platform tests.',
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    architecture: 'multi-file',
    dimensions: { width: 1920, height: 1080 },
    totalSlides: slides.length,
    slides,
    fonts: [],
    tokens: {
      colors: { primary: '#C04A1A', ink: '#1A1A1A', paper: '#FAFAFA' },
    },
    assets: { totalSize: 0, count: 0, files: [] },
    runtime: {
      presenterTools: 'platform',
      fallbackEntry: null,
      capabilities: ['keyboard-nav', 'thumbnail-preview', 'speaker-notes'],
    },
    platform: {
      minSchemaVersion: '1.0',
      compatibleArchitectures: ['multi-file'],
    },
    stats: {
      packedAt: NOW_ISO,
      packerVersion: 'slidestage-platform-fixture@0.1.0',
    },
  };
}

/* --------------------------------- ZIP ---------------------------------- */

/**
 * Minimal ZIP writer (PKZip format). Stores deflate-compressed entries.
 */
function makeZip(entries) {
  const localChunks = [];
  const central = [];
  let offset = 0;

  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const compressed = zlib.deflateRawSync(data);
    const crc = crcCompute(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file signature
    localHeader.writeUInt16LE(20, 4); // version
    localHeader.writeUInt16LE(0x0800, 6); // utf-8 flag
    localHeader.writeUInt16LE(8, 8); // method = deflate
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const entryBuf = Buffer.concat([localHeader, nameBuf, compressed]);
    localChunks.push(entryBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42);

    central.push(Buffer.concat([centralHeader, nameBuf]));
    offset += entryBuf.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

/* ----------------------------- Build pipeline --------------------------- */

function build({ targetPath = OUT_FILE } = {}) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const manifest = buildManifest();

  const files = [];

  // Slide files first.
  for (let i = 0; i < SLIDES.length; i++) {
    const slide = SLIDES[i];
    files.push({
      name: `slides/${String(i + 1).padStart(2, '0')}-${slide.id}.html`,
      content: slide.html,
    });
  }

  // Thumbnails.
  for (let i = 0; i < SLIDES.length; i++) {
    files.push({
      name: `thumbnails/${String(i + 1).padStart(2, '0')}.png`,
      content: generateThumbnailPng(i + 1),
    });
  }

  // speaker-notes.json (redundant copy per spec §9.1).
  files.push({
    name: 'speaker-notes.json',
    content: JSON.stringify(SLIDES.map((s) => s.notes ?? ''), null, 2),
  });

  // Update assets manifest from disk sizes (we just compute from buffers).
  const assetFiles = files
    .filter((f) => f.name.startsWith('thumbnails/'))
    .map((f) => ({
      path: f.name,
      size: Buffer.isBuffer(f.content)
        ? f.content.length
        : Buffer.byteLength(f.content),
      type: 'image',
    }));
  manifest.assets = {
    totalSize: assetFiles.reduce((acc, a) => acc + a.size, 0),
    count: assetFiles.length,
    files: assetFiles,
  };

  // Manifest must be present, write last so other entries already populated assets.
  files.unshift({
    name: 'manifest.json',
    content: JSON.stringify(manifest, null, 2),
  });

  const zipBuf = makeZip(files);
  fs.writeFileSync(targetPath, zipBuf);

  const sha = crypto.createHash('sha256').update(zipBuf).digest('hex');
  console.log(`Built ${path.relative(ROOT, targetPath)} (${zipBuf.length} bytes, sha256=${sha.slice(0, 16)}…)`);
  return { path: targetPath, size: zipBuf.length, sha };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build();
}

export { build, buildManifest, makeZip, generateThumbnailPng };
