# AGENTS.md

This public repository is an execution plane, not the canonical policy/source repository.

## Canonical owner

All security, validation-routing, publication, and Human/Machine boundary decisions are owned by private `clockcrockwork/note-projects`.

Do not broaden this repository's task surface because it is convenient. If a runtime change would weaken or reinterpret the private canonical, change/review the private canonical first.

## Non-negotiable invariants

- typed tasks only; no arbitrary shell/command/repository/ref/path/env input
- privileged request authorization occurs before any private token mint
- same-repository PR only for executable SOURCE_SHA
- reviewed private main remains the source of trusted policy/tooling such as source-export policy and validation planner
- purchased licensed font bytes are never fetched into the public runner
- unpublished/paid payload is never uploaded to public Actions artifacts/cache or committed to this repository
- dependency installation happens before private source export and receives no GitHub App secret/token
- private SOURCE_SHA executable code runs only after installation tokens are revoked and without outbound network
- raw private-tool stdout/stderr is never streamed into public logs
- public results contain only reviewed safe metadata such as opaque task/target IDs, exact source SHA, PASS/FAIL/HOLD, stable diagnostics and counts
- do not use `pull_request_target` for privileged execution
- secret-bearing third-party actions must be pinned to full commit SHA

If a required execution plane is unavailable, report a machine HOLD. Do not turn the missing executor into a per-PR Human shell command.

## Publication Preview route guard

For a normal Publication Preview request, use this repository's typed `publication-preview` task as the primary execution route.

```text
Human / ChatGPT request
-> public note-projects-cli Actions
-> publication-preview
-> fixed private-source ingress
-> target-specific preview build
-> protected Vercel deployment / probe
-> protected URL handoff
```

Do not infer this route is unavailable merely because private `clockcrockwork/note-projects` Actions are quota-limited, have `runner_id=0`, have `steps=[]`, or the qualified private/render lane is blocked.

The route **does use public GitHub Actions and a GitHub-hosted runner**. The correct boundary is:

```text
independent of private note-projects Actions quota
!=
independent of Actions / runners
```

Do not redirect a normal preview request to Owner-local `npm`, Vercel CLI, Vercel login, or per-Article `VERCEL_TOKEN` creation/copy/paste.

If this public typed route itself is unavailable, fail closed rather than inventing a Human local-shell fallback.
