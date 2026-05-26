import type { Config } from "../config.js";
import { LocalStorageDriver } from "./local.js";
import type { StorageDriver } from "./types.js";

export function createStorage(config: Config): StorageDriver {
  switch (config.storage.driver) {
    case "local":
      return new LocalStorageDriver({ dataDir: config.storage.dataDir });
    default: {
      const exhaustive: never = config.storage.driver;
      throw new Error(`unsupported STORAGE_DRIVER: ${exhaustive as string}`);
    }
  }
}

export type { StorageDriver } from "./types.js";
export { LocalStorageDriver } from "./local.js";
