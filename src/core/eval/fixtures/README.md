# Eval fixtures

Each fixture is a small, anonymized snapshot of pipeline inputs used by
`delta eval` for regression testing.

Layout:

```
fixtures/
  index.json                 # array of EvalCase descriptors
  cases/
    <case-id>/
      experience.json        # an ExperienceLog
      events/                # optional raw events
      jd.txt                 # optional JD text
      expected.md            # optional human-curated reference resume
```

The judge model receives the generated draft + `expected.md` (if any) and
returns scores along the 5 dimensions defined in `schema/eval.ts`.

PR3 will land the first 5–10 fixture cases. Until then this directory is
intentionally empty.
