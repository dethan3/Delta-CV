# Architecture

Delta CV is a single TypeScript package with two runtime entrypoints (CLI and GitHub Action) that share a core library.

## Data Flow

```text
                        ┌─────────────────────────────────┐
                        │         User's GitHub            │
                        │   (commits, PRs, issues, reviews) │
                        └──────────────┬──────────────────┘
                                       │
                          ┌────────────▼────────────┐
                          │       observe            │
                          │  collector/github-*.ts   │
                          │  collector/denoise.ts    │
                          │  collector/cursor.ts     │
                          └────────────┬────────────┘
                                       │
                          data/events/<yyyy-Www>.jsonl
                          data/_meta/cursor.json
                                       │
                          ┌────────────▼────────────┐
                          │       evolve             │
                          │  engine/cluster.ts       │
                          │  engine/tag.ts           │
                          │  engine/translate.ts     │  ← LLM calls
                          │  engine/focus.ts         │
                          │  engine/snapshot.ts      │
                          └────────────┬────────────┘
                                       │
                          data/_meta/experience.json
                          data/snapshots/<date>.json
                                       │
                          ┌────────────▼────────────┐
                          │       tailor             │
                          │  tailor/render.ts        │
                          │  tailor/jd-rerank.ts     │
                          │  lint/banned-words.ts    │
                          │  lint/line-length.ts     │
                          └────────────┬────────────┘
                                       │
                          data/tailored/<slug>.md
                                       │
                          ┌────────────▼────────────┐
                          │     github/pr.ts         │
                          │  (Action only: commit    │
                          │   changes, create PR)    │
                          └─────────────────────────┘
```

## Module Map

```text
src/
├── cli.ts                    CLI entrypoint (citty)
├── action.ts                 GitHub Action entrypoint
├── version.ts                VERSION constant
└── core/
    ├── pipeline.ts           Top-level orchestration: observe, evolve, tailor
    ├── llm.ts                LLM HTTP client (OpenAI-compatible + Anthropic)
    ├── prompts.ts            Prompt loader with user-override support
    ├── collector/
    │   ├── github-graphql.ts GraphQL contributionsCollection fetching
    │   ├── github-rest.ts    REST API issue search fallback
    │   ├── denoise.ts        Bot/squash/merge-commit filtering
    │   └── cursor.ts         Watermark read/write for incremental runs
    ├── engine/
    │   ├── cluster.ts        Group events by repo + month
    │   ├── tag.ts            Fuzzy-match events against capability vocab
    │   ├── tag-vocab.ts      86 canonical technology tags
    │   ├── translate.ts      LLM: cluster → ExperienceEntry
    │   ├── focus.ts          Tag frequency + trend detection
    │   └── snapshot.ts       Snapshot build + diff
    ├── tailor/
    │   ├── render.ts         Eta template rendering → Markdown
    │   └── jd-rerank.ts      Keyword-based entry reranking (no LLM)
    ├── lint/
    │   ├── banned-words.ts   Scan resume for clichés
    │   └── line-length.ts    Line length + highlight count limits
    ├── github/
    │   └── pr.ts             Git Data API: branch, commit, PR, error issues
    ├── io/
    │   ├── data.ts           JSONL/JSON read/write for events, logs, snapshots
    │   ├── env.ts            .env.local loader
    │   └── assets.ts         Bundled asset loader (prompts, templates, banned words)
    └── schema/
        ├── config.ts         Config, LlmConfig, EngineConfig
        ├── event.ts          EventEnvelope (kind, repo, ts, payload)
        ├── experience.ts     ExperienceEntry, ExperienceLog, Highlight
        └── snapshot.ts       Snapshot, SnapshotDiff, FocusItem
```

## Key Design Decisions

### Single Package, Two Entrypoints

One `package.json`, one `src/core/`, two entry files:
- `src/cli.ts` → bundled as `dist/cli.js` (npm bin)
- `src/action.ts` → bundled as `dist/index.js` (GitHub Action)

Both share 100% of `src/core/`. Build uses `tsup` with two separate entry configs.

### No LLM SDK

`src/core/llm.ts` is ~80 lines of raw `fetch` + `zod` validation. Supports:
- `openai-compatible` provider (DeepSeek, OpenAI, etc.)
- `anthropic` provider

This avoids SDK bloat and gives full control over retry logic and error handling.

### Schema-First Data Model

All data flowing between modules is validated with Zod schemas:
- `EventEnvelope` — raw GitHub activity
- `ExperienceEntry` — LLM-generated structured experience
- `Snapshot` — point-in-time capability state
- `Config` — user configuration

### Template-Based Resume Output

Resume rendering uses [Eta](https://eta.js.org/) templates in `assets/resume-templates/`. Three variants: `zh`, `en`, `bilingual`. Users can override by placing templates in their repo.

### User-Owned Private Repos

Users get a clean private repo with only their data. After the first release, the main repo will be referenced via a pinned Action tag such as `uses: delta-cv/delta@v1` — no fork, no source code leakage.

## Extension Points

| Extension | How |
|-----------|-----|
| Custom prompts | Place `prompts/evolve.<lang>.md` in your repo — overrides bundled prompts |
| Custom banned words | Place `prompts/banned_words.<lang>.txt` in your repo |
| Custom resume template | Place `resume-templates/resume.<lang>.md.eta` in your repo |
| Additional LLM providers | Add a new branch in `llm.ts` `callApi()` |
| Additional data sources | Add new collectors alongside `collector/github-*.ts` |
| Additional tag vocabulary | Edit `engine/tag-vocab.ts` (PRs welcome) |

## Testing Strategy

| Layer | Tool | What |
|-------|------|------|
| Unit | Vitest | Pure functions: denoise, cursor, tag, lint, render |
| Schema | Zod | All LLM I/O validated at boundary |
| Golden | Vitest snapshot | events JSONL → experience log structure |
| LLM | Fixture replay | Real LLM calls recorded locally, CI replays fixtures |
| Integration | Vitest | Pipeline stages with mocked externals |
| E2E | GitHub Actions | Weekly run against demo account |

## Dependencies

**Runtime** (6 total):
`@octokit/graphql`, `@octokit/rest`, `zod`, `eta`, `fast-fuzzy`, `citty`

**Dev**: TypeScript, tsx, vitest, biome, tsup, commitlint, simple-git-hooks

No LLM SDK, no lodash, no axios, no monorepo tools.
