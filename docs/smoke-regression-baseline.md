# Smoke Regression Baseline

Date: `2026-05-25`

## Commands Run

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build:cli
pnpm build:action
node dist/cli.js eval --config-path config.smoke.json --data-dir /private/tmp/delta-smoke --fixtures-dir src/core/eval/fixtures
node dist/cli.js verify-facts --config-path config.smoke.json --data-dir /private/tmp/delta-verify --slug default
```

## Results

- `typecheck`: passed
- `build:cli`: passed
- `build:action`: passed
- `delta eval`: passed, 5 fixture cases evaluated
- `delta verify-facts`: passed, `0` issues, `coverage=1.00`

## Eval Aggregate

```json
{
  "selection_quality": 4.6,
  "positioning_quality": 10,
  "bullet_specificity": 5.6,
  "fact_groundedness": 10,
  "jd_alignment": 7
}
```

## Notes

- This is a minimal regression baseline built from fixed fixtures under `src/core/eval/fixtures/`.
- Current eval scoring is heuristic-first, so changes in these numbers should be interpreted as smoke signals, not final quality judgments.
- Temporary runtime outputs were written to `/private/tmp/delta-smoke` and `/private/tmp/delta-verify`.
