# HTML Templates

Delta renders HTML resumes from structured `ResumeDraft` JSON using Eta templates.

## Built-in templates

- `clean.eta`
- `compact.eta`
- `developer.eta`

These are the official examples for how template-based rendering works.

## Template data contract

Templates receive:

- `draft`: the raw `ResumeDraft`
- `view`: a stable template-facing object
- `esc()`: HTML escaping helper

`view` contains:

- `lang`
- `login`
- `headline`
- `summary`
- `generatedDate`
- `labels`
- `skills[]`
- `selectedProjects[]`
- `otherExperience[]`

## User templates

Recommended local path:

```text
.local/templates/
```

Example usage:

```bash
node dist/cli.js render --slug default --template .local/templates/my-template.html.eta
```

User templates should remain local and should not be committed.
