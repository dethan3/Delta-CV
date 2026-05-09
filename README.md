# Delta CV

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

Turn your real GitHub engineering activity into a continuously updated resume — no manual editing, no AI fluff.

Delta CV collects your commits, PRs, issues, and reviews, clusters them into meaningful projects, extracts your actual technology stack and focus areas, and renders a Markdown resume that stays current automatically via a weekly GitHub Action.

> Status: pre-release. The CLI is not published to npm yet; use the source checkout for now.

## Quickstart

```bash
# 1. Install dependencies and build the CLI
pnpm install
pnpm build

# 2. Scaffold a private resume repo
node dist/cli.js init my-resume
cd my-resume

# 3. Edit config.json — set your GitHub login and LLM provider

# 4. Push to a PRIVATE GitHub repo
git remote add origin git@github.com:<you>/my-resume.git
git push -u origin main

# 5. Add secrets in GitHub (Settings → Secrets):
#    LLM_API_KEY  — your DeepSeek/OpenAI/Anthropic key

# 6. Trigger the first run:
#    Actions → Delta CV → Run workflow → mode: bootstrap
```

After 5–15 minutes, a PR will appear with your generated resume.

## How It Works

```text
GitHub Activity
    │
    ▼
┌─────────┐     ┌─────────┐     ┌─────────┐
│ observe  │ ──▶ │ evolve  │ ──▶ │ tailor  │
│ (fetch)  │     │ (LLM)   │     │ (render) │
└─────────┘     └─────────┘     └─────────┘
    │               │               │
    ▼               ▼               ▼
 data/events/   experience.json   resume.md
 cursor.json    snapshot.json     tailored/
```

1. **observe** — Fetches your GitHub activity (commits, PRs, issues, reviews) via GraphQL + REST APIs.
2. **evolve** — Clusters events by project, tags capabilities, detects focus shifts, and generates structured experience entries via LLM.
3. **tailor** — Renders a Markdown resume from the experience log. Optionally reranks highlights against a target job description.

A weekly GitHub Action runs this pipeline automatically and opens a PR with any changes.

## CLI Commands

| Command | Description |
|---------|-------------|
| `delta init [dir]` | Scaffold a new resume repo from the template |
| `delta observe` | Fetch GitHub events → `data/events/` |
| `delta evolve` | Process events → experience log + snapshot via LLM |
| `delta tailor [--jd <file>]` | Generate resume, optionally ranked against a JD |
| `delta lint <file>` | Check resume for banned words and structural limits |

## Configuration

Edit `config.json` in your resume repo:

```jsonc
{
  "login": "your-github-username",
  "language": "zh",                    // "zh", "en", or "bilingual"
  "llm": {
    "provider": "openai-compatible",   // or "anthropic"
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat"
  },
  "ignore": {
    "repos": ["forked-repo"],
    "authors": ["dependabot[bot]", "renovate[bot]"]
  },
  "schedule": {
    "cron": "0 0 * * 1",               // weekly on Monday
    "lookbackDays": 7
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `login` | (required) | Your GitHub username |
| `language` | `"zh"` | Resume output language |
| `llm.provider` | `"openai-compatible"` | LLM API provider |
| `llm.baseUrl` | DeepSeek URL | API base URL |
| `llm.model` | `"deepseek-chat"` | Model name |
| `ignore.repos` | `[]` | Repos to exclude from collection |
| `ignore.authors` | `[dependabot, renovate]` | Bot authors to filter |
| `schedule.cron` | `"0 0 * * 1"` | Action schedule (cron) |
| `schedule.lookbackDays` | `7` | Days to look back on incremental runs |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LLM_API_KEY` | Yes | API key for your LLM provider |
| `GITHUB_TOKEN` | Auto | Provided by GitHub Actions; set manually for local use |
| `LLM_BASE_URL` | No | Override `config.json` llm.baseUrl |
| `LLM_MODEL` | No | Override `config.json` llm.model |

## GitHub Action

After the first release, the Action will be usable from GitHub with a pinned tag:

```yaml
- uses: delta-cv/delta@v1 # not published yet
  with:
    mode: incremental  # or "bootstrap" for first run
  env:
    LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
```

The Action runs the full `observe → evolve → tailor` pipeline and opens a PR with the updated resume.

## Privacy

- All processing runs in **your** GitHub Actions runner.
- LLM calls use **your** API key — no data is sent to Delta CV servers.
- Default: reads only **public** repos. Use `include-private: true` explicitly for private repos.
- No telemetry is collected.

## FAQ

**Q: Why a private repo?**
Your resume data is personal. The template creates a private repo by default. The Action runs entirely within your repo.

**Q: How much does the LLM cost?**
Typical weekly runs cost < $0.01 with DeepSeek. Bootstrap (3 years of history) costs < $0.05.

**Q: Can I customize the resume template?**
Yes. Copy `assets/resume-templates/` to your repo and edit the Eta templates. The `delta tailor` command will use your custom templates.

**Q: Can I use this with GitLab/Bitbucket?**
Not yet. Multi-platform support is planned for post-v1.0.

**Q: The PR has AI-sounding language.**
Run `delta lint resume.md` to catch banned words. You can customize the banned words list in `prompts/banned_words.<lang>.txt`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, commit conventions, and PR guidelines.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the data flow, module boundaries, and extension points.

## License

[AGPL-3.0-or-later](LICENSE) — see [CLA.md](CLA.md) for the contributor agreement.
