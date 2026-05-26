# Changesets

This directory tracks version bumps + release notes for SlideStage Pro.
Pro is a **self-hosted** product (no npm publishing today), so changesets
is used here primarily for:

1. Authoring a release-notes / version bump as part of a PR.
2. Keeping the four workspace packages on a consistent version number
   so the Docker image tag (`ghcr.io/slidestage/pro-api:vX.Y.Z`) matches
   what `apps/api/package.json` reports at runtime.
3. Acting as the trigger for `.github/workflows/release.yml` — running
   `pnpm version-packages` followed by a git tag push (`vX.Y.Z`) causes
   the release workflow to build + push the Pro Docker images to GHCR.

## Workspace Packages

```
apps/api            @slidestage/pro-api        (private, Docker image)
apps/web            @slidestage/pro-web        (private, Docker image)
packages/pro-preset @slidestage/pro-preset     (private today; candidate
                                                for npm if/when we want
                                                external customization)
packages/pro-shared @slidestage/pro-shared     (private, internal)
```

`privatePackages.version = true` + `privatePackages.tag = true` in
`config.json` makes changesets version + git-tag private packages —
needed because *all* current Pro packages are private. If we later
flip `pro-preset` to public, the same changeset flow can publish it
to npm without further configuration changes.

## Workflow

1. Make code changes inside the workspace.
2. `pnpm changeset` — answer the wizard (patch / minor / major) and
   write a release-notes summary. A new `.changeset/*.md` is created;
   commit it alongside the PR.
3. After merge, run `pnpm version-packages`. This consumes pending
   `.changeset/*.md`, bumps each affected workspace package, regenerates
   per-package `CHANGELOG.md`, and commits.
4. Tag the merge commit (`git tag v0.1.1 && git push origin v0.1.1`).
   `.github/workflows/release.yml` reacts to that tag and builds /
   pushes Docker images to `ghcr.io/slidestage/pro-{api,web}:v0.1.1`
   plus the floating `latest` tag.

## Lite Boundary

Changesets here MUST NOT bump `@slidestage/core`, `@slidestage/ui`,
`@slidestage/lite-preset`, or `@slidestage/spec` — those live in the
Lite repo and are consumed via npm semver. `pnpm check:boundaries`
enforces the rule.
