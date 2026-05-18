import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ERROR_CODES } from '@slidestage/shared';
import { makeZip } from '../../../scripts/build-fixture.mjs';
import { safeExtract } from '../src/pipeline/extract.js';

const tmpRoots: string[] = [];

async function makeTmpRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slidestage-extract-test-'));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function corruptCentralDirectoryUncompressedSize(
  zip: Buffer,
  entryName: string,
  size: number,
): Buffer {
  const copy = Buffer.from(zip);
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = 0;
  while ((offset = copy.indexOf(signature, offset)) !== -1) {
    const nameLength = copy.readUInt16LE(offset + 28);
    const extraLength = copy.readUInt16LE(offset + 30);
    const commentLength = copy.readUInt16LE(offset + 32);
    const name = copy.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === entryName) {
      copy.writeUInt32LE(size, offset + 24);
      return copy;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`central directory entry not found: ${entryName}`);
}

describe('safeExtract', () => {
  it('rejects entries whose actual inflated size exceeds the per-file limit', async () => {
    const root = await makeTmpRoot();
    const archivePath = path.join(root, 'compressed-large.stage');
    const destDir = path.join(root, 'out');
    await fs.writeFile(
      archivePath,
      makeZip([{ name: 'payload.bin', content: Buffer.alloc(256 * 1024, 0x61) }]),
    );

    await expect(
      safeExtract(archivePath, destDir, {
        maxDecompressedBytes: 1024 * 1024,
        maxFileBytes: 64 * 1024,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.EBOMB });
  });

  it('counts streamed bytes when the ZIP size header is misleading', async () => {
    const root = await makeTmpRoot();
    const archivePath = path.join(root, 'misleading-size.stage');
    const destDir = path.join(root, 'out');
    const zip = makeZip([
      { name: 'payload.bin', content: Buffer.alloc(128 * 1024, 0x62) },
    ]);
    await fs.writeFile(
      archivePath,
      corruptCentralDirectoryUncompressedSize(zip, 'payload.bin', 1),
    );

    await expect(
      safeExtract(archivePath, destDir, {
        maxDecompressedBytes: 1024 * 1024,
        maxFileBytes: 64 * 1024,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.EBOMB });
  });
});
