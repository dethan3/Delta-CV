# Contributing to Delta CV

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Development Setup

```bash
# Clone and install
git clone https://github.com/delta-cv/delta.git
cd delta
pnpm install

# Optional: set up local env for LLM-backed stages
cp .env.local.example .env.local
# Edit .env.local and add your LLM_API_KEY

# Verify everything works
pnpm verify
```

### Prerequisites

- Node.js >= 20
- pnpm (see `packageManager` in package.json)

### Project Structure

```text
src/
  cli.ts              CLI entry (delta command)
  action.ts           GitHub Action entry
  core/
    collector/        GitHub data fetching
    engine/           Clustering, tagging, translation, snapshot
    tailor/           Resume rendering + JD reranking
    lint/             Banned words + structural checks
    schema/           Zod type definitions
    io/               File I/O, env loading, asset loading
    github/           PR creation and issue reporting
    pipeline.ts       Top-level orchestration
    llm.ts            LLM HTTP client
    prompts.ts        Prompt loader
assets/               Prompts, banned words, resume templates
template/             Starter files for user repos
tests/                Vitest test files
```

## Commit Style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(core): add focus-shift detector
fix(collector): handle rate limit reset header
docs: update quickstart guide
test(m2): add snapshot diff golden test
chore: bump dependencies
```

Types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`, `ci`.

Scope is optional but recommended: `core`, `collector`, `engine`, `tailor`, `lint`, `cli`, `action`.

## Branching & PRs

1. Create a feature branch from `main`.
2. Make focused changes — one concern per PR.
3. Run `pnpm verify` before pushing.
4. Open a PR with a clear description of what changed and why.
5. Keep PRs under 500 lines of diff. Split larger changes.

### PR Checklist

- [ ] `pnpm verify` passes (lint, typecheck, test, build)
- [ ] New code has tests
- [ ] Commit messages follow Conventional Commits
- [ ] Code, comments, and docs are in English

## Testing

```bash
pnpm test            # run all tests
pnpm test:watch      # watch mode
```

### Test Organization

- `tests/m0.test.ts` — Config schema, basic lint helpers
- `tests/m1.test.ts` — Collection: cursor, denoise, GraphQL/REST mapping, pipeline.observe
- `tests/m2.test.ts` — Engine: clustering, tagging, focus, snapshot, LLM client, persistence
- `tests/m3.test.ts` — Tailor: render, JD reranking, banned words, structural lint
- `tests/m4.test.ts` — Action: PR creation, error issues, init scaffold

### Writing Tests

- Use `vi.mock()` for external dependencies (Octokit, fetch).
- Use temp directories (`tmpdir()`) for filesystem tests.
- Assert structure, not specific LLM output text.
- Name test files by milestone: `m<N>.test.ts`.

## Coding Standards

- **Language**: English for all code, comments, commit messages, and docs.
- **Formatting**: Biome (`pnpm format`). No Prettier or ESLint.
- **Types**: `strict: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`.
- **No `any`**: Use `unknown` and narrow with type guards.
- **No non-null assertions**: Use optional chaining or explicit checks.
- **Imports**: Use `import type` for type-only imports.

## Environment Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `LLM_API_KEY` | `.env.local` / Action secret | LLM provider API key |
| `GITHUB_TOKEN` | `.env.local` / Action secret | GitHub personal access token |
| `LLM_BASE_URL` | `.env.local` / env | Override LLM base URL |
| `LLM_MODEL` | `.env.local` / env | Override LLM model name |

Never commit `.env.local` or any file containing real API keys.

## Reporting Issues

Open an issue on GitHub with:
- A clear title and description
- Steps to reproduce (if a bug)
- Expected vs actual behavior
- Relevant logs or error messages

## License

By contributing, you agree that your contributions will be licensed under AGPL-3.0-or-later.
