# note-projects-cli

Public qualified compute plane for selected private `clockcrockwork` repositories.

The private repositories remain canonical. This repository contains reviewed runner/bootstrap code only; it must never become a mirror of unpublished/paid content, private operational state, or licensed font bytes.

## Typed tasks

The request surface is deliberately closed:

- `repository-verify` — fixed source repository: `clockcrockwork/note-projects`
- `threads-affiliates-verify` — fixed source repository: `clockcrockwork/threads-affiliates`
- `verify-publication`
- `publication-prepare`
- `publication-preview`
- `patreon-cover-render` — fixed source repository: `clockcrockwork/patreon`; execution is exposed through the dedicated public `Patreon cover render` workflow

No public input may choose an arbitrary command, repository URL, branch/tag/SHA, path, or environment value. Repository identity is selected by reviewed task code, not by the request.

`repository-verify` resolves a numeric `note-projects` PR to one exact `SOURCE_SHA`, obtains the changed-path plan from reviewed private `main`, installs dependencies before source export, exports only the private-canonical allowlist with its hard denylist, revokes App tokens, and runs the selected public-safe commands inside a `--network none` container. Raw child output is captured rather than streamed to public Actions logs.

`threads-affiliates-verify` provides the same public-CI boundary for the Reply Inbox affiliate owner stack. It resolves only numeric PRs in the fixed `clockcrockwork/threads-affiliates` repository, exports only package/runtime/test/build inputs required by `npm test` and `npm run build:gas`, rejects unsafe paths/symlinks/gitlinks, revokes the private-source token before source execution, and executes the private source only inside a no-network container. Documentation-only changes may return `NOT_REQUIRED` without exporting or executing private source.

Publication tasks remain typed and follow their separately qualified activation boundaries.

## Publication Preview execution boundary

`publication-preview` is the primary machine entry point for protected Publication Preview delivery. It is **not** a request for the Owner to run `npm`, Vercel CLI, or copy a Vercel token into an Article-specific session.

Canonical operational shape:

```text
Human / ChatGPT request
  -> this public note-projects-cli repository
  -> typed task: publication-preview
  -> public GitHub-hosted ubuntu-latest job
  -> fixed private-source ingress from clockcrockwork/note-projects
  -> exact SOURCE_SHA preview build
  -> clean target-specific payload
  -> protected Vercel deployment + access probe
  -> protected URL handoff
```

This boundary matters when the private `clockcrockwork/note-projects` repository has exhausted or unavailable Actions capacity:

```text
private note-projects Actions unavailable
!=
public note-projects-cli publication-preview unavailable
```

The public workflow itself still uses GitHub Actions and a GitHub-hosted runner. Therefore phrases such as “Publication Preview does not use Actions” or “Publication Preview is runner-independent” are inaccurate. The correct statement is that the canonical preview route is independent of **private `note-projects` Actions quota / runner allocation**, because execution occurs here on the public plane.

Before declaring Publication Preview unavailable, check this public typed route itself. A failed private workflow with `runner_id=0`, `steps=[]`, private quota exhaustion, or a blocked qualified render lane is not evidence that `publication-preview` is unavailable.

Normal operation must not require the Owner to have a PC or terminal. Do not ask the Owner to run or provide any of the following merely to create a normal preview:

```text
npm ci
SOURCE_SHA=... npm run build:publication-preview ...
npx vercel deploy ...
vercel login
per-Article VERCEL_TOKEN creation / copy / paste
```

Those are implementation/debugging/break-glass mechanisms. If this public typed task itself is unavailable, fail closed and report the execution-plane problem; do not silently convert it into a Human local-shell requirement.

Real dogfood evidence:

- ART-012 reached protected Publication Preview end-to-end on 2026-09-11.
- ART-008: Issue #126 / run `34685544484`, `publication_preview` PASS on public `ubuntu-latest`.
- ART-009: Issue #127 / run `34685548387`, `publication_preview` PASS on public `ubuntu-latest`.

The Vercel credential is an infrastructure activation secret. Once wired to the runner, it is not a per-Article Human handoff.

## One-time activation boundary

The privileged workflow expects GitHub Actions environment `private-source-read` with these secrets:

- `NPR_APP_ID`
- `NPR_APP_PRIVATE_KEY`
- `NPR_APP_INSTALLATION_ID`

The GitHub App installation must include every private source repository used by an activated typed task, currently:

- `clockcrockwork/note-projects`
- `clockcrockwork/threads-affiliates`
- `clockcrockwork/patreon` for `patreon-cover-render`

Grant only the minimum read permissions required for Contents and Pull Requests. Do not create a second secret set merely because another fixed repository is added to the qualified carrier; prefer one deliberately scoped installation when the same trust boundary applies.

If a typed task selects a repository that is not included in the installation, token minting fails before any private source SHA or blob is obtained. Never work around that by broadening the request surface to accept arbitrary repositories.

Until the environment credentials exist, private-source tasks fail closed before any private API request.

## No public payload storage

The workflows intentionally do not use `actions/cache` or `actions/upload-artifact` for private source/output.

A narrow exception exists for outputs that have already crossed an explicit export boundary. `patreon-cover-render` may upload only the three publication-bound PNG cover sizes plus a sanitized manifest. Its private source media must first be committed under `covers/media/public-ready/` in the canonical Patreon repository and declared by `covers/public-render-manifest.json`. The workflow never uploads the private request, renderer source, source media, package files, or raw command logs.

Public Actions is therefore compute for private canonical state, with durable artifacts limited to material already approved for publication.

## Patreon cover render carrier

`.github/workflows/patreon-cover-render.yml` moves deterministic cover rendering off the private Patreon repository and onto this public compute plane.

Contract:

- the private `clockcrockwork/patreon` repository remains canonical;
- the public workflow accepts only `PTN-COVER-*` targets declared in the private main-branch render manifest;
- renderer/package/logo tooling is always fetched from trusted private `main`, even when rendering a private pull request;
- a pull request may therefore change only the request/media data consumed by trusted tooling, not the renderer executed on the public runner;
- media must come from the private repository's explicit `covers/media/public-ready/` export boundary;
- the GitHub App token is revoked before dependency install, tests, and rendering;
- dependency installation uses `npm ci --ignore-scripts` against package metadata from trusted private `main`;
- artifacts are reduced to exactly 1920x1080, 320x180, and 240x135 PNGs plus a SHA-256 manifest;
- no raw private command output is intentionally emitted.

Use **Actions → Patreon cover render → Run workflow**. Select a declared target, choose `main` for normal publication rendering, or `pull_request` plus a numeric Patreon PR when validating request/media changes before merge.

The current private GitHub Actions quota does not need to be consumed by this operation; the workflow itself runs in this public repository.

## Playwright runtime carrier

`.github/workflows/playwright-runtime-carrier.yml` implements `PLAYWRIGHT_RUNTIME_CARRIER_V1`. It is unrelated to the typed remote-run request surface above and never reads a private repository: it downloads the Playwright-managed OSS Chromium headless shell for a pinned Playwright version onto a public GitHub-hosted runner, verifies it (CLI version, browser files, executable permission, an actual `chromium.launch()` smoke test), packages it into a permission-preserving `tar.gz`, and uploads that plus a manifest as a public GitHub Actions artifact — `playwright-runtime-1.63.0-linux-x64-headless-shell` — so a Playwright-based runtime that cannot reach the Playwright CDN directly (for example ChatGPT Work) can retrieve it instead through an authenticated GitHub UI/API session.

Contract:

- **Not a canonical artifact store.** This is a *regenerable public runtime carrier*. Artifacts use `retention-days: 30`; once retention expires, re-run the workflow from trusted `main` (`workflow_dispatch`, no inputs) to regenerate the same named artifact.
- **Version is pinned in code, not by input.** The workflow takes no `workflow_dispatch` inputs at all — `1.63.0` is fixed in `scripts/playwright-runtime-manifest.mjs` and mirrored in the workflow's `env`. Changing the Playwright version is a reviewed repository change, not a per-run parameter.
- **Only OSS runtime bytes are carried.** The artifact contains the Playwright-managed Chromium headless shell (Google's own redistributable Chrome for Testing build) and a carrier manifest — never note-projects source, ART-002 output, purchased fonts, or any other private/paid payload. This does not conflict with this repository's "no public payload storage" note above, which is about private source/output, not third-party OSS toolchain binaries.
- **A PR-triggered run is not a qualified runtime.** The workflow also runs on `pull_request` when its own files change, purely to validate the workflow; only an artifact generated from a run on trusted `main` should be treated as a qualified runtime source.

`PLAYWRIGHT_RUNTIME_CARRIER_V2` is implemented separately in `.github/workflows/playwright-runtime-carrier-v2.yml`; V1 remains unchanged for its existing consumers. V2 carries the matching complete pair required by Playwright 1.63.0: full Chromium and Chromium headless shell. Before packaging it runs both `chromium.launch()` and `chromium.launch({ channel: 'chromium' })`, then records each executable's revision, cache directory, relative path, executable mode, size, and SHA-256 in its schema-v2 manifest. The tar verifier hashes both executable entries directly from the archive stream, so a downstream receiver can distinguish carrier corruption from local extraction/materialization corruption.
