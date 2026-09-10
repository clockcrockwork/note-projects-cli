# note-projects-cli

Public compute plane for private `clockcrockwork/note-projects`.

The private repository remains canonical. This repository contains reviewed runner/bootstrap code only; it must never become a mirror of unpublished/paid Article content or licensed font bytes.

## Typed tasks

The request surface is deliberately closed:

- `repository-verify`
- `verify-publication`
- `publication-prepare`
- `publication-preview`

No public input may choose an arbitrary command, repository URL, branch/tag/SHA, path, or environment value.

`repository-verify` is the first activated task. It resolves a numeric same-repository private PR to one exact `SOURCE_SHA`, obtains the changed-path plan from reviewed private `main`, installs dependencies before source export, exports only the private-canonical allowlist with its hard denylist, revokes App tokens, and runs the selected public-safe commands inside a `--network none` container. Raw child output is captured rather than streamed to public Actions logs.

Publication tasks remain typed but intentionally return `HOLD: TYPED_TASK_NOT_ACTIVATED` until their separate private-content / protected-preview planes are activated.

## One-time activation boundary

The privileged workflow expects GitHub Actions environment `private-source-read` with these secrets:

- `NPR_APP_ID`
- `NPR_APP_PRIVATE_KEY`
- `NPR_APP_INSTALLATION_ID`

The GitHub App must be installed only on `clockcrockwork/note-projects` with the minimum read permissions required for Contents and Pull Requests. Until those values exist, `repository-verify` fails closed as `HOLD: EXECUTION_PLANE_CREDENTIALS_UNAVAILABLE` before any private API request.

## No public payload storage

The workflows intentionally do not use `actions/cache` or `actions/upload-artifact` for private source/output. Public Actions is compute, not a durable private-content store.

## Playwright runtime carrier

`.github/workflows/playwright-runtime-carrier.yml` implements `PLAYWRIGHT_RUNTIME_CARRIER_V1`. It is unrelated to the typed remote-run request surface above and never reads a private repository: it downloads the Playwright-managed OSS Chromium headless shell for a pinned Playwright version onto a public GitHub-hosted runner, verifies it (CLI version, browser files, executable permission, an actual `chromium.launch()` smoke test), packages it into a permission-preserving `tar.gz`, and uploads that plus a manifest as a public GitHub Actions artifact — `playwright-runtime-1.63.0-linux-x64-headless-shell` — so a Playwright-based runtime that cannot reach the Playwright CDN directly (for example ChatGPT Work) can retrieve it instead through an authenticated GitHub UI/API session.

Contract:

- **Not a canonical artifact store.** This is a *regenerable public runtime carrier*. Artifacts use `retention-days: 30`; once retention expires, re-run the workflow from trusted `main` (`workflow_dispatch`, no inputs) to regenerate the same named artifact.
- **Version is pinned in code, not by input.** The workflow takes no `workflow_dispatch` inputs at all — `1.63.0` is fixed in `scripts/playwright-runtime-manifest.mjs` and mirrored in the workflow's `env`. Changing the Playwright version is a reviewed repository change, not a per-run parameter.
- **Only OSS runtime bytes are carried.** The artifact contains the Playwright-managed Chromium headless shell (Google's own redistributable Chrome for Testing build) and a carrier manifest — never note-projects source, ART-002 output, purchased fonts, or any other private/paid payload. This does not conflict with this repository's "no public payload storage" note above, which is about private source/output, not third-party OSS toolchain binaries.
- **A PR-triggered run is not a qualified runtime.** The workflow also runs on `pull_request` when its own files change, purely to validate the workflow; only an artifact generated from a run on trusted `main` should be treated as a qualified runtime source.

`PLAYWRIGHT_RUNTIME_CARRIER_V2` is implemented separately in `.github/workflows/playwright-runtime-carrier-v2.yml`; V1 remains unchanged for its existing consumers. V2 carries the matching complete pair required by Playwright 1.63.0: full Chromium and Chromium headless shell. Before packaging it runs both `chromium.launch()` and `chromium.launch({ channel: 'chromium' })`, then records each executable's revision, cache directory, relative path, executable mode, size, and SHA-256 in its schema-v2 manifest. The tar verifier hashes both executable entries directly from the archive stream, so a downstream receiver can distinguish carrier corruption from local extraction/materialization corruption.
