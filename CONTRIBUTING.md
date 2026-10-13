# Contributing

Thanks for looking. Spotted London is a showcase project that is also open to contributions: bug reports, fixes and small features are welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the idea.
- The rules for verification, scoring and agents are deliberate. Read [CLAUDE.md](CLAUDE.md) ("Rules that are easy to break") and [SPEC.md](SPEC.md) before changing them.
- Free tier only: Cloudflare Workers Free has about 10 ms CPU per request and D1 has a daily read limit. Keep handlers light.

## Setup

Follow "Set up locally" in [README.md](README.md). You do not need a Cloudflare account: `npm run dev:local` runs everything except AI autofill from pasted text and screenshots.

## Before you open a pull request

```bash
npm run build:web
npm test
npm run typecheck && (cd web && npx tsc --noEmit)
```

The same checks run on every pull request in GitHub Actions (`.github/workflows/ci.yml`). They need to pass before merging.

- Add or update a test for behaviour you change (`test/`).
- A new migration goes in `migrations/` with the next number, and must not break the code that is already deployed.
- UI copy is plain English with no em dashes. Check phone layout at 375 px.
- Never commit secrets. `.dev.vars` is git-ignored; use `.dev.vars.example` for new variables.

## Licence

By contributing you agree that your contribution is released under the [MIT licence](LICENSE).
