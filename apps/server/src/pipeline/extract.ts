/**
 * Safe ZIP extraction with the following defenses:
 *  • Zip-slip: every entry's resolved path must stay inside the destination
 *    (spec §5.2).
 *  • Zip-bomb: cumulative decompressed size capped before we start writing
 *    (spec §5.3).
 *  • Per-file cap to keep one ginormous video from blowing past the rest.
 *  • Reject symlinks / device files / weird ZIP attributes — only regular
 *    files and directories are allowed (spec §2.3).
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { ERROR_CODES, SlideStageError } from '@slidestage/shared';

export interface ExtractOptions {
  maxDecompressedBytes: number;
  maxFileBytes: number;
}

export interface ExtractResult {
  fileCount: number;
  totalBytes: number;
}

const POSIX_FILE_TYPE_MASK = 0xf000;
const POSIX_REGULAR_FILE = 0x8000;
const POSIX_DIRECTORY = 0x4000;

function openZip(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      {
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: false,
      },
      (err, zipfile) => {
        if (err || !zipfile) {
          reject(
            new SlideStageError(
              ERROR_CODES.EUNZIP,
              `Failed to open ZIP: ${(err ?? new Error('no zipfile')).message}`,
            ),
          );
          return;
        }
        resolve(zipfile);
      },
    );
  });
}

function normalizeZipError(err: Error): Error {
  if (err instanceof SlideStageError) return err;
  if (
    err.message.includes('invalid relative path') ||
    err.message.includes('invalid characters in fileName')
  ) {
    return new SlideStageError(
      ERROR_CODES.EZIPSLIP,
      `Zip slip detected: ${err.message}`,
      400,
    );
  }
  return new SlideStageError(
    ERROR_CODES.EUNZIP,
    `Failed to read ZIP: ${err.message}`,
    400,
  );
}

function readNextEntry(zipfile: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zipfile.off('entry', onEntry);
      zipfile.off('end', onEnd);
      zipfile.off('error', onError);
    };
    const onEntry = (entry: Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(normalizeZipError(err));
    };

    zipfile.once('entry', onEntry);
    zipfile.once('end', onEnd);
    zipfile.once('error', onError);
    zipfile.readEntry();
  });
}

function openEntryStream(zipfile: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error(`Failed to read ZIP entry ${entry.fileName}`));
        return;
      }
      resolve(stream);
    });
  });
}

function byteCountingTransform(
  rawName: string,
  opts: ExtractOptions,
  addTotalBytes: (bytes: number) => void,
): Transform {
  let fileBytes = 0;
  return new Transform({
    transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: TransformCallback,
    ) {
      const chunkBytes = chunk.length;
      fileBytes += chunkBytes;
      if (fileBytes > opts.maxFileBytes) {
        callback(
          new SlideStageError(
            ERROR_CODES.EBOMB,
            `File ${rawName} exceeds per-file limit ${opts.maxFileBytes}`,
            413,
          ),
        );
        return;
      }

      try {
        addTotalBytes(chunkBytes);
      } catch (err) {
        callback(err as Error);
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Extracts the ZIP at `archivePath` into `destDir`. The destination directory
 * must already exist and be empty (callers create a temp dir for staging).
 */
export async function safeExtract(
  archivePath: string,
  destDir: string,
  opts: ExtractOptions,
): Promise<ExtractResult> {
  const destAbs = path.resolve(destDir);
  await fs.mkdir(destAbs, { recursive: true });

  const zip = await openZip(archivePath);
  let totalBytes = 0;
  let fileCount = 0;
  let sawEntry = false;

  try {
    for (;;) {
      const entry = await readNextEntry(zip);
      if (!entry) break;
      sawEntry = true;
      const rawName = entry.fileName;

      if (rawName.includes('\0')) {
        throw new SlideStageError(
          ERROR_CODES.EZIPSLIP,
          `Zip entry contains null byte: ${JSON.stringify(rawName)}`,
        );
      }

      const normalized = path.posix.normalize(rawName);
      if (
        normalized.startsWith('/') ||
        normalized.startsWith('..') ||
        normalized.includes('/../')
      ) {
        throw new SlideStageError(
          ERROR_CODES.EZIPSLIP,
          `Zip slip detected: ${rawName}`,
        );
      }

      const target = path.resolve(destAbs, normalized);
      if (target !== destAbs && !target.startsWith(destAbs + path.sep)) {
        throw new SlideStageError(
          ERROR_CODES.EZIPSLIP,
          `Zip slip detected: ${rawName}`,
        );
      }

      const attr = entry.externalFileAttributes ?? 0;
      const fileType = (attr >>> 16) & POSIX_FILE_TYPE_MASK;
      if (
        fileType !== 0 &&
        fileType !== POSIX_REGULAR_FILE &&
        fileType !== POSIX_DIRECTORY
      ) {
        throw new SlideStageError(
          ERROR_CODES.EZIPSLIP,
          `Unsupported entry type at ${rawName}; only regular files and directories allowed`,
        );
      }

      if (rawName.endsWith('/') || fileType === POSIX_DIRECTORY) {
        await fs.mkdir(target, { recursive: true });
        continue;
      }

      const declaredSize = entry.uncompressedSize;
      if (declaredSize > opts.maxFileBytes) {
        throw new SlideStageError(
          ERROR_CODES.EBOMB,
          `File ${rawName} is ${declaredSize} bytes, exceeds per-file limit ${opts.maxFileBytes}`,
          413,
        );
      }
      if (totalBytes + declaredSize > opts.maxDecompressedBytes) {
        throw new SlideStageError(
          ERROR_CODES.EBOMB,
          `Decompressed size exceeds limit ${opts.maxDecompressedBytes}`,
          413,
        );
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      const source = await openEntryStream(zip, entry);
      const counter = byteCountingTransform(rawName, opts, (bytes) => {
        totalBytes += bytes;
        if (totalBytes > opts.maxDecompressedBytes) {
          throw new SlideStageError(
            ERROR_CODES.EBOMB,
            `Decompressed size exceeds limit ${opts.maxDecompressedBytes}`,
            413,
          );
        }
      });
      try {
        await streamPipeline(source, counter, createWriteStream(target));
      } catch (err) {
        await fs.rm(target, { force: true }).catch(() => {});
        throw err;
      }
      fileCount++;
    }
  } finally {
    zip.close();
  }

  if (!sawEntry) {
    throw new SlideStageError(ERROR_CODES.EUNZIP, 'ZIP is empty');
  }

  return { fileCount, totalBytes };
}
