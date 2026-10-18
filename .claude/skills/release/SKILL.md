---
name: bc-mcp-release
description: Release `business-central-mcp` to npm — bumps version, builds, tests, dry-run-inspects the tarball, publishes, and pushes the tag. Use this whenever the user wants to ship a new version, publish to npm, cut a release, tag a version, or asks "how do we release this". Also use when the user has finished a body of work and asks what's next, since release is often the natural next step after merging features. Walks through preflight checks, semver decision, and post-publish smoke. Publishing is done by the GitHub Release workflow on tag push (npm Trusted Publishing) — never run `npm publish` locally; the tag push needs explicit confirmation, releases are irreversible.
---

# bc-mcp release runbook

Release `business-central-mcp` to npm. The package is configured for manual
publish via `prepublishOnly` (typecheck + build); the rest is gated by you
to keep destructive operations safe.

This is a runbook, not an automated tool. Walk the user through each step,
pausing on anything destructive (version bump, publish, tag push) for
explicit confirmation. Releases are irreversible — npm allows unpublish only
within 72 hours of publish, and only if no other package depends on the
exact version.

## Preflight checklist

Run these before suggesting a version bump. If any fail, stop and surface
the failure — don't paper over it.

```bash
cd U:/Git/bc-mcp        # or wherever the repo lives

# Working tree clean?
git status --short          # expect empty
git rev-parse --abbrev-ref HEAD   # expect master

# Up-to-date with origin?
git fetch origin
git status -sb              # expect "## master...origin/master" with no behind/ahead

# All tests pass?
npm run typecheck           # tsc on src and on src+tests (tsconfig.test.json), expect exit 0
npm test                    # unit + protocol, expect green
npm run test:integration    # against live BC, expect green (skip if no BC available, but flag the skip)

# CHANGELOG up-to-date?
grep -q "^## \[Unreleased\]" CHANGELOG.md && echo "OK: [Unreleased] section exists"
# Inspect the [Unreleased] section — it should describe what's about to ship.
```

If integration tests can't run (no live BC), explicitly tell the user
"integration tests skipped — running CI to compensate". CI will run unit +
protocol on Node 20/22/24 against the master branch via
`.github/workflows/ci.yml`.

## Step 1: Pick the version

Read `package.json` to see the current version. Compare against published
versions on npm:

```bash
npm view business-central-mcp versions --json
```

Decide the bump per semver:

| Change kind | pre-1.0 (`0.x.y`) | post-1.0 (`x.y.z`) |
|---|---|---|
| Bug fix only | `0.x.y` patch | `x.y.z` patch |
| New feature, backwards-compatible | `0.x.0` minor | `x.y.0` minor |
| Breaking change to public API | `0.x.0` minor (allowed pre-1.0) | `x.0.0` major |

For bc-mcp specifically: the public API surface is the **MCP tool output
shapes** (what `bc_open_page`, `bc_read_data`, etc. return) and the **env
var contract** (`BC_BASE_URL`, `BC_PROFILE`, etc.). Changes to internal
protocol/services/operations are not public API.

Tell the user the proposed version and the reasoning. Wait for confirmation
before running `npm version`.

## Step 2: Update CHANGELOG

The CHANGELOG follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Before bumping, rename the `[Unreleased]` section header to
`[<version>] - YYYY-MM-DD` and add a fresh empty `[Unreleased]` section above
it.

```markdown
## [Unreleased]

### Added
### Changed
### Fixed

## [0.2.0] - 2026-04-28

### Added
... (the previous Unreleased content) ...
```

Commit this CHANGELOG-only change BEFORE running `npm version`, so the
version bump commit is solely the package.json + lockfile change. Cleaner
history.

```bash
git add CHANGELOG.md
git commit -m "docs: prepare CHANGELOG for v<version>"
```

## Step 3: Bump version

`npm version` updates `package.json`, runs the
`prepublishOnly` script (typecheck + build), creates a tagged commit. It
will refuse if the working tree is dirty — that's why Step 2 commits first.

```bash
npm version <patch|minor|major>     # creates commit + tag v<version>
```

Verify:

```bash
git log -1 --format='%H %s'         # expect "<sha> <version>" auto-message
git tag --list 'v*' --sort=-creatordate | head -3   # tag should be v<version>
```

## Step 4: Inspect the tarball

Before publishing, see exactly what npm will ship. The `files` field in
`package.json` is `["dist/"]` — only compiled output. Verify nothing
sensitive sneaks in (no `.env`, no `reference/`, no `logs/`).

```bash
npm pack --dry-run 2>&1 | tail -50
```

Look for:
- `dist/stdio-server.js` — the bin entry
- `dist/server.js` — the HTTP server
- `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md` (auto-included)
- NOTHING from `reference/`, `tests/`, `scripts/`, `.env*`, `logs/`,
  `docs/`, `*.md` other than README/CHANGELOG

If the tarball looks wrong, stop and fix `files` or `.npmignore`. Don't
publish a leaky tarball — `npm unpublish` is restricted.

## Step 5: Verify the bin shebang

The bin file (`dist/stdio-server.js`) must start with `#!/usr/bin/env node`
or `npx business-central-mcp` won't execute. tsc preserves shebangs from the
source by default; verify just in case.

```bash
head -1 dist/stdio-server.js
# expect: #!/usr/bin/env node
```

If it's missing, add the shebang to `src/stdio-server.ts` (top line, before
imports) and rebuild.

## Step 6: Publish = push the tag (do NOT run `npm publish` locally)

Publishing is done by `.github/workflows/release.yml`, triggered by any `v*`
tag push. It publishes via npm Trusted Publishing (OIDC, with provenance, no
NPM_TOKEN), after gating on: tag == package.json version, `npm run test`, and
`npm run smoke:prod`. It also builds the `.dxt` and creates the GitHub release
(auto-generated notes) with the `.dxt` attached.

A local `npm publish` is wrong: it ships without provenance and makes the
workflow fail on the duplicate version. No `npm login` is needed.

Run the workflow's smoke gate locally first, then confirm with the user
(irreversible) and push:

```bash
npm run smoke:prod
git push --follow-tags              # pushes master + the tag -> Release workflow publishes
gh run list --workflow=release.yml --limit 1
gh run watch <run-id> --exit-status
```

## Step 7: Confirm the workflow published

When the run is green, `npm view business-central-mcp version` shows the new
version. If the run failed before "Publish to npm", fix, then move the tag
only with the user's explicit approval (it is a destructive tag rewrite).

## Step 8: Post-publish smoke

Verify the publish actually worked by installing fresh in a temp dir:

```bash
cd /tmp
mkdir bc-mcp-smoke && cd bc-mcp-smoke
npm init -y > /dev/null
npm install business-central-mcp@<version>
npx business-central-mcp --help 2>&1 | head -5      # or whatever the binary supports
ls node_modules/business-central-mcp/dist/          # confirm files arrived
cd .. && rm -rf bc-mcp-smoke
```

If the smoke fails (binary not executable, missing files, missing
dependency), the publish is broken. Options:
- **Within 72 hours**: `npm unpublish business-central-mcp@<version>` then
  fix and re-publish a new patch version. Don't re-use the same version
  number — npm forbids it even after unpublish.
- **After 72 hours, or if forbidden**: publish a patch on top
  (e.g. 0.2.0 broken → 0.2.1 with the fix). Update the npm "deprecated"
  message on the broken version: `npm deprecate business-central-mcp@0.2.0 "broken bin shebang, use 0.2.1+"`.

## Step 9: GitHub release notes (optional)

The workflow's `build-dxt` job already creates the GitHub release (auto-generated
notes + `.dxt`). To replace its notes with the CHANGELOG section, edit it, don't
create a second release:

```bash
awk '/^## \[<version>\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md > notes.md   # read it first
gh release edit v<version> --notes-file notes.md
```

## Failure recovery

If something goes wrong mid-flow:

| Failure | Recovery |
|---|---|
| Release workflow failed before "Publish to npm" | Nothing shipped. Fix on master; re-pointing the tag needs the user's explicit OK (delete + re-push the tag), or cut the next patch version instead. |
| Release workflow failed AT "Publish to npm" | Check npmjs.com trusted-publisher config for this repo/workflow, then re-run the job (`gh run rerun <id> --failed`). Never fall back to a local `npm publish`. |
| Wrong version published | `npm unpublish business-central-mcp@<version>` (within 72h) OR publish a corrected patch and `npm deprecate` the bad one. |
| Tarball leaked secrets | Treat as a credential rotation: revoke the leaked secret, `npm unpublish` if within 72h, otherwise publish a fixed version + deprecate. Tarballs on npm cache servers may persist even after unpublish. |
| CI failed on the release commit | Don't unpublish — investigate the failure. CI failures on a freshly-released commit usually mean a flaky test or a Node-version-specific issue (matrix runs Node 20/22/24). If a real regression, ship a patch ASAP. |

## What the user should hand-verify

After all steps complete, ask the user to confirm:

1. `npm view business-central-mcp version` returns the new version.
2. `npm view business-central-mcp dist-tags` shows `latest: <new-version>`.
3. The GitHub Actions CI run on the new commit is green.
4. Optional: `npx -y business-central-mcp@<version>` works in a fresh shell.

If any of these are wrong, flag it — the release isn't truly done.

## Skipping CHANGELOG / running ad-hoc

If the user wants a quick patch publish without going through CHANGELOG
ceremony (e.g. fixing a critical post-publish bug), the minimal flow is:

```bash
# Edit code, commit normally
npm version patch
git push --follow-tags       # the Release workflow publishes
```

This skips Step 2 (CHANGELOG) — fine for emergencies. Backfill the CHANGELOG
in the next non-emergency commit.
