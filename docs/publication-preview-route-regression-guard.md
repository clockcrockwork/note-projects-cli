# Publication Preview regression guard

This public repository is the normal execution plane for the `publication-preview` typed task.

## Invariant

```text
private clockcrockwork/note-projects Actions availability
!=
this public publication-preview route availability
```

The task still uses GitHub Actions: `.github/workflows/remote-run.yml` runs the activated `publication_preview` job on public `ubuntu-latest`. The independence is from the **private repository's Actions quota / runner allocation**, not from Actions or runners in general.

## Normal operator boundary

A normal Article preview request must not be converted into any of these Owner steps:

```text
npm ci
npm run build:publication-preview
npx vercel deploy
vercel login
create/copy/paste VERCEL_TOKEN for an Article
```

Those are implementation/debugging/break-glass operations. Credentials are one-time infrastructure activation, not per-request Human relay.

If this public typed task itself cannot execute, fail closed. Do not prescribe a local-shell fallback as the ordinary recovery route.

## Evidence

- ART-008: Issue #126 / run `34685544484` — `publication_preview` PASS.
- ART-009: Issue #127 / run `34685548387` — `publication_preview` PASS.

Both runs used public GitHub-hosted runners after the private repository had already encountered Actions capacity constraints, demonstrating the intended plane separation.
