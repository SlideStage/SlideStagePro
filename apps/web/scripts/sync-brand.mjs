#!/usr/bin/env node
// Mirror the npm-published @slidestage/brand/assets/ tree into this app's
// `public/brand/` directory so vite's `publicDir` machinery serves the same
// bytes in dev (`pnpm dev`) and copies them into `dist/brand/` on build.
//
// `public/brand/` is in `.gitignore` because @slidestage/brand@npm is the
// single source of truth for those bytes.

import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(here);
const require = createRequire(import.meta.url);

const brandPkgJson = require.resolve('@slidestage/brand/package.json');
const brandAssetsRoot = join(dirname(brandPkgJson), 'assets');
const publicBrandDir = join(appRoot, 'public', 'brand');

await rm(publicBrandDir, { recursive: true, force: true });
await mkdir(publicBrandDir, { recursive: true });
await cp(brandAssetsRoot, publicBrandDir, { recursive: true });

console.log(
  `[sync-brand] mirrored ${brandAssetsRoot} → ${publicBrandDir}`,
);
