/**
 * Driver-agnostic blob storage interface. v0 ships `local` only; an
 * `s3`/`r2`/`minio` driver can implement the same shape.
 *
 * `key` is an opaque, slash-separated identifier (e.g. `decks/<id>/<ver>.stage`).
 * Drivers MUST reject path traversal in their implementation; callers should
 * still avoid building keys from user-supplied paths.
 */
export interface StorageDriver {
  putObject(key: string, bytes: Uint8Array | Buffer): Promise<void>;
  getObject(key: string): Promise<ReadableStream<Uint8Array> | Buffer>;
  deleteObject(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /**
   * Cheap probe used by /api/health. Should succeed when the driver's
   * backing store is reachable and writable.
   */
  health(): Promise<{ ok: boolean; detail?: string }>;
}
