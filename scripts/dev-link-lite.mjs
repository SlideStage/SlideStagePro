#!/usr/bin/env node
/**
 * dev-link-lite.mjs — Toggle local SlideStageLite checkout into Pro's
 * `@slidestage/{core,ui,lite-preset,spec}` deps for development.
 *
 * Use case:
 *   You're iterating on a Lite package and want Pro to consume the
 *   in-progress source tree rather than the published npm version.
 *   Without this script you'd either (a) keep publishing dev snapshots
 *   of Lite to npm, or (b) hand-edit `pnpm.overrides` in Pro's root
 *   `package.json` and forget to revert it before committing.
 *
 * Usage:
 *   pnpm dev:link-lite              # link mode (writes pnpm.overrides)
 *   pnpm dev:link-lite:unlink       # unlink mode (clears pnpm.overrides)
 *
 * Safety:
 *   - The Lite checkout MUST live at the sibling path `../SlideStageLite`
 *     and have each `packages/{core,ui,lite-preset,spec}` present.
 *   - Linking writes `pnpm.overrides` into Pro's `package.json`. The
 *     boundary rule `.cursor/rules/lite-package-boundary.mdc` forbids
 *     committing `link:../SlideStageLite/...` refs, so the script
 *     prints a giant warning reminding you to UNLINK before committing.
 *     `pnpm check:boundaries` will additionally fail on a committed
 *     override (defense in depth).
 *   - The unlink path restores `package.json` to exactly its pre-link
 *     state (no stray empty `overrides: {}` block).
 *
 * Why not `pnpm link --global`?
 *   pnpm's global link uses the Lite package's `main`/`exports` as-is,
 *   which points to `./src/index.ts` (dev mode). Pro's runtime
 *   toolchain (tsup-built dist for packages, tsx watch for the API
 *   dev server) can handle .ts directly, but Pro's `pnpm build` then
 *   ships .ts source into the docker image, which is wrong. Using
 *   `link:../SlideStageLite/packages/<x>` keeps the same `exports`
 *   layered map that npm-published Lite would expose, so Pro gets the
 *   built dist/ if Lite ran `pnpm -r build`, or the dev path if not.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRO_ROOT = resolve(__dirname, '..');
const PKG_JSON_PATH = resolve(PRO_ROOT, 'package.json');
const LITE_ROOT = resolve(PRO_ROOT, '..', 'SlideStageLite');

const LITE_PACKAGES = [
  { name: '@slidestage/core', dir: 'packages/core' },
  { name: '@slidestage/ui', dir: 'packages/ui' },
  { name: '@slidestage/lite-preset', dir: 'packages/lite-preset' },
  { name: '@slidestage/spec', dir: 'packages/spec' },
];

const args = process.argv.slice(2);
const isUnlink = args.includes('--unlink');

function color(code, text) {
  return process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}
const bold = (s) => color('1', s);
const red = (s) => color('31', s);
const green = (s) => color('32', s);
const yellow = (s) => color('33', s);
const dim = (s) => color('2', s);

function fail(msg) {
  console.error(red(`[dev-link-lite] FATAL: ${msg}`));
  process.exit(1);
}

function readPkg() {
  return JSON.parse(readFileSync(PKG_JSON_PATH, 'utf-8'));
}
function writePkg(pkg) {
  writeFileSync(PKG_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n');
}

function ensureLiteCheckout() {
  if (!existsSync(LITE_ROOT) || !statSync(LITE_ROOT).isDirectory()) {
    fail(
      `Lite checkout missing at ${LITE_ROOT}.\n` +
        '         Clone the Lite repo as a sibling of this one:\n' +
        '             cd ../ && git clone https://github.com/SlideStage/SlideStageLite.git',
    );
  }
  for (const { name, dir } of LITE_PACKAGES) {
    const pkgPath = resolve(LITE_ROOT, dir, 'package.json');
    if (!existsSync(pkgPath)) {
      fail(
        `${name} not found at ${pkgPath}.\n` +
          "         Either you have an outdated Lite checkout (pull main) or you're on a branch where the package was renamed.",
      );
    }
  }
}

function applyOverrides() {
  ensureLiteCheckout();
  const pkg = readPkg();
  pkg.pnpm = pkg.pnpm || {};
  pkg.pnpm.overrides = pkg.pnpm.overrides || {};
  for (const { name, dir } of LITE_PACKAGES) {
    pkg.pnpm.overrides[name] = `link:../SlideStageLite/${dir}`;
  }
  writePkg(pkg);

  console.log(green('[dev-link-lite] Wrote pnpm.overrides into package.json:'));
  for (const { name, dir } of LITE_PACKAGES) {
    console.log(`  ${name}  →  link:../SlideStageLite/${dir}`);
  }

  console.log('\n' + dim('Running `pnpm install` to refresh the lockfile…'));
  const r = spawnSync('pnpm', ['install'], { cwd: PRO_ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    fail('`pnpm install` failed; package.json overrides are still applied. Run `pnpm dev:link-lite:unlink` to restore.');
  }

  console.log('\n' + yellow(bold('⚠  DO NOT COMMIT package.json IN THIS STATE.')));
  console.log(
    yellow(
      '   `pnpm check:boundaries` will reject the commit and the boundary rule\n' +
        '   (.cursor/rules/lite-package-boundary.mdc) forbids link: refs in version control.\n' +
        '   Run `pnpm dev:link-lite:unlink` to restore the npm-semver deps before committing.',
    ),
  );
}

function removeOverrides() {
  const pkg = readPkg();
  if (!pkg.pnpm || !pkg.pnpm.overrides) {
    console.log(green('[dev-link-lite] No pnpm.overrides present — nothing to unlink.'));
    return;
  }
  let removed = 0;
  for (const { name } of LITE_PACKAGES) {
    if (pkg.pnpm.overrides[name]) {
      delete pkg.pnpm.overrides[name];
      removed += 1;
    }
  }
  if (Object.keys(pkg.pnpm.overrides).length === 0) {
    delete pkg.pnpm.overrides;
  }
  if (Object.keys(pkg.pnpm).length === 0) {
    delete pkg.pnpm;
  }
  writePkg(pkg);
  console.log(green(`[dev-link-lite] Cleared ${removed} Lite overrides from package.json.`));

  console.log('\n' + dim('Running `pnpm install` to restore the npm-semver deps…'));
  const r = spawnSync('pnpm', ['install'], { cwd: PRO_ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    fail('`pnpm install` failed after unlink. Manual cleanup may be required.');
  }
  console.log(green('\n✓ Restored npm-semver Lite deps.'));
}

if (isUnlink) {
  removeOverrides();
} else {
  applyOverrides();
}
