# My Resume (powered by Delta CV)

This repository contains my personal resume data, managed automatically by
[Delta CV](https://github.com/delta-cv/delta).

## Setup

1. Edit `config.json` — set `login` to your GitHub username and configure your LLM provider.
2. Copy `.env.local.example` to `.env.local` and fill `LLM_API_KEY` when you are ready to run LLM-backed stages.
3. For local development, run Delta CV from the source checkout until the Action flow is enabled.
4. After the pipeline is implemented, check `resume.md` for your generated resume.

Missing `LLM_API_KEY` is valid during early local development.

## Files

| Path | Description |
|------|-------------|
| `config.json` | Delta configuration |
| `resume.md` | Auto-generated resume (do not edit by hand) |
| `tailored/` | JD-tailored resume variants |
| `data/` | Raw event and experience data (committed for auditability) |

## Manual tailor

```bash
node /path/to/delta/dist/cli.js tailor --jd path/to/jd.txt
```
