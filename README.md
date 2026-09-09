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
