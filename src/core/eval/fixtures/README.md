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

The current minimal implementation supports two fixture shapes:

- prebuilt artifacts: `draft.resume.json` + optional `narratives.json` / `jd-profile.json`
- pipeline inputs: `experience.json` + optional `narratives.json` / `plan.json` / `jd.txt`

The current fixture set includes 5 fixed cases so `delta eval` can run a
small deterministic regression pass even without full live pipeline data.
