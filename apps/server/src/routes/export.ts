/**
 * Deck export route — Stage A.5 extension.
 *
 *   GET /api/decks/:id/export
 *
 * Repacks `<storageRoot>/<deckId>` (which already reflects any owner-side
 * speaker-note edits — see routes/notes.ts) into a fresh `.stage` zip and
 * streams it back to the client. The resulting archive matches the upload
 * format byte-for-byte enough to be re-uploaded into another platform
 * instance without any extra steps.
 *
 * Why repack from disk instead of the DB:
 *   - Keeps the response single-source-of-truth: whatever the platform serves
 *     under /storage is what gets exported.
 *   - Lets us include any non-manifest assets (slides/, thumbnails/, fonts/...)
 *     untouched.
 */
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { ERROR_CODES, SlideStageError } from '@slidestage/shared';
import type { AppConfig } from '../config.js';
import { getPrisma } from '../db.js';
import { getUserId } from '../auth.js';

interface RouteDeps {
  config: AppConfig;
}

const paramsSchema = z.object({ id: z.string() });
const ZIP_UTF8_FLAG = 0x0800;

interface ZipFileEntry {
  abs: string;
  rel: string;
  size: number;
  crc32: number;
  mtime: Date;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function updateCrc32(crc: number, chunk: Buffer): number {
  let next = crc;
  for (const byte of chunk) {
    next = CRC32_TABLE[(next ^ byte) & 0xff]! ^ (next >>> 8);
  }
  return next >>> 0;
}

async function checksumFile(abs: string): Promise<{ crc32: number; size: number }> {
  let crc = 0xffffffff;
  let size = 0;
  for await (const chunk of createReadStream(abs)) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    crc = updateCrc32(crc, buf);
  }
  return { crc32: (crc ^ 0xffffffff) >>> 0, size };
}

async function collectZipEntries(
  dir: string,
  rootForZip: string,
): Promise<ZipFileEntry[]> {
  const out: ZipFileEntry[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || e.name.includes('.tmp-')) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(rootForZip, full).split(path.sep).join('/');
    if (e.isDirectory()) {
      out.push(...await collectZipEntries(full, rootForZip));
    } else if (e.isFile()) {
      const stat = await fs.stat(full);
      const { crc32, size } = await checksumFile(full);
      out.push({ abs: full, rel, size, crc32, mtime: stat.mtime });
    }
  }
  return out;
}

function dosDateTime(date: Date): { dosDate: number; dosTime: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    dosDate:
      ((year - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
    dosTime:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
  };
}

function localFileHeader(entry: ZipFileEntry, name: Buffer): Buffer {
  const { dosDate, dosTime } = dosDateTime(entry.mtime);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(entry.crc32, 14);
  header.writeUInt32LE(entry.size, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name]);
}

function centralDirectoryHeader(
  entry: ZipFileEntry,
  name: Buffer,
  localHeaderOffset: number,
): Buffer {
  const { dosDate, dosTime } = dosDateTime(entry.mtime);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(dosTime, 12);
  header.writeUInt16LE(dosDate, 14);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.size, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(localHeaderOffset, 42);
  return Buffer.concat([header, name]);
}

function endOfCentralDirectory(
  entryCount: number,
  centralSize: number,
  centralOffset: number,
): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

async function writeChunk(out: PassThrough, chunk: Buffer): Promise<void> {
  if (!out.write(chunk)) {
    await once(out, 'drain');
  }
}

function assertZip32(entries: ZipFileEntry[]): void {
  if (entries.length > 0xffff) {
    throw new SlideStageError(ERROR_CODES.ETOOLARGE, 'too many files to export', 413);
  }
  for (const entry of entries) {
    if (entry.size > 0xffffffff) {
      throw new SlideStageError(
        ERROR_CODES.ETOOLARGE,
        `file too large to export as ZIP32: ${entry.rel}`,
        413,
      );
    }
  }
}

function zipContentLength(entries: ZipFileEntry[]): number {
  let total = 22;
  for (const entry of entries) {
    const nameLength = Buffer.byteLength(entry.rel);
    total += 30 + nameLength + entry.size;
    total += 46 + nameLength;
  }
  return total;
}

async function writeZipStream(
  entries: ZipFileEntry[],
  out: PassThrough,
): Promise<void> {
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.rel);
    const localOffset = offset;
    const localHeader = localFileHeader(entry, name);
    await writeChunk(out, localHeader);
    offset += localHeader.length;

    for await (const chunk of createReadStream(entry.abs)) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      await writeChunk(out, buf);
      offset += buf.length;
    }

    const centralHeader = centralDirectoryHeader(entry, name, localOffset);
    central.push(centralHeader);
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const header of central) {
    await writeChunk(out, header);
    centralSize += header.length;
    offset += header.length;
  }
  await writeChunk(out, endOfCentralDirectory(entries.length, centralSize, centralOffset));
  out.end();
}

function safeExportFilename(deckId: string): string {
  // ASCII-only, no slashes, no quotes — safe for Content-Disposition.
  const safe = deckId.replace(/[^A-Za-z0-9._-]/g, '-') || 'deck';
  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, '-')
    .slice(0, 19); // 2026-04-30-10-12-33
  return `${safe}-${stamp}.stage`;
}

export async function registerExportRoute(
  app: FastifyInstance,
  { config }: RouteDeps,
): Promise<void> {
  const prisma = getPrisma();

  app.get<{ Params: { id: string } }>(
    '/api/decks/:id/export',
    async (req, reply) => {
      const userId = await getUserId(req, config);
      const { id } = paramsSchema.parse(req.params);

      const deck = await prisma.deck.findUnique({ where: { id } });
      if (!deck || deck.ownerId !== userId) {
        reply.code(404);
        throw new SlideStageError(
          ERROR_CODES.EMISSINGFILE,
          `deck not found: ${id}`,
          404,
        );
      }

      const storageDir = path.join(config.storageRoot, deck.storageRoot);
      try {
        await fs.access(storageDir);
      } catch {
        throw new SlideStageError(
          ERROR_CODES.EMISSINGFILE,
          `deck storage missing on disk: ${deck.storageRoot}`,
          500,
        );
      }

      const entries = await collectZipEntries(storageDir, storageDir);
      assertZip32(entries);
      const contentLength = zipContentLength(entries);

      const filename = safeExportFilename(deck.id);
      reply.header('Content-Type', 'application/vnd.stage+zip');
      reply.header(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );
      reply.header('Content-Length', String(contentLength));
      reply.header('x-deck-id', deck.id);
      reply.header('Cache-Control', 'no-store');
      const stream = new PassThrough();
      void writeZipStream(entries, stream).catch((err) => {
        stream.destroy(err as Error);
      });
      return reply.send(stream);
    },
  );
}
