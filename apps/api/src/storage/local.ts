import { createReadStream } from "node:fs";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { StorageDriver } from "./types.js";

export interface LocalStorageOptions {
  /** Absolute or process-relative root. Created on first write if missing. */
  dataDir: string;
}

/**
 * Validate that `key` is a safe relative path inside `root`. Throws on any
 * absolute path, NUL byte, `..` segment that escapes root, drive letters, or
 * other suspicious shapes. Returns the resolved absolute path.
 */
function safeJoin(root: string, key: string): string {
  if (!key || typeof key !== "string") {
    throw new Error("storage key required");
  }
  if (key.includes("\0")) throw new Error("storage key may not contain NUL");
  if (isAbsolute(key)) throw new Error("storage key may not be absolute");
  // Normalize first to collapse `..` then verify containment.
  const cleaned = key.replace(/\\/g, "/");
  if (cleaned.startsWith("/")) throw new Error("storage key may not start with /");
  const abs = resolve(root, cleaned);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || rel === "" || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new Error(`storage key escapes root: ${key}`);
  }
  return abs;
}

export class LocalStorageDriver implements StorageDriver {
  private readonly root: string;

  constructor(opts: LocalStorageOptions) {
    this.root = resolve(opts.dataDir);
  }

  private async ensureRoot() {
    await mkdir(this.root, { recursive: true });
  }

  async putObject(key: string, bytes: Uint8Array | Buffer): Promise<void> {
    await this.ensureRoot();
    const target = safeJoin(this.root, key);
    await mkdir(dirname(target), { recursive: true });
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    await writeFile(target, buffer);
  }

  async getObject(key: string): Promise<ReadableStream<Uint8Array> | Buffer> {
    const target = safeJoin(this.root, key);
    // Throw early if missing so callers can map to 404.
    await access(target);
    const nodeStream = createReadStream(target);
    return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
  }

  async deleteObject(key: string): Promise<void> {
    const target = safeJoin(this.root, key);
    await rm(target, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const target = safeJoin(this.root, key);
      await access(target);
      return true;
    } catch {
      return false;
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.ensureRoot();
      const st = await stat(this.root);
      if (!st.isDirectory()) {
        return { ok: false, detail: "DATA_DIR is not a directory" };
      }
      // Touch a probe file to verify writability.
      const probe = join(this.root, ".health-probe");
      await writeFile(probe, Buffer.from(""));
      await rm(probe, { force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Best-effort cleanup helper used by deck delete. */
  async deletePrefix(prefix: string): Promise<void> {
    const abs = safeJoin(this.root, prefix);
    await rm(abs, { recursive: true, force: true });
  }
}

export function normalizeKey(key: string): string {
  return normalize(key.replace(/\\/g, "/")).replace(/^[\\/]+/, "");
}
