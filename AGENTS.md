# AGENTS.md

## Key commands

- `npm install`
- `npm run dev:api`
- `npm run dev:web`
- `npm run build`
- `npm run test`
- `npm exec --workspace @pi-chat/api -- vitest run src/env.test.ts`

## Hints

- Use `vitest run` for one-shot test execution. Avoid plain `vitest` when you need the command to exit instead of watching for file changes.
- The API loads `.env` from the repository root when present.
- Install package changes for a single workspace with `npm install --workspace <package-name>`.