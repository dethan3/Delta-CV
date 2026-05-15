# Delta CV

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

Turn your real GitHub engineering activity into a precisely crafted, evidence-backed resume — no manual editing, no AI fluff.

Delta CV collects your commits, PRs, issues, and reviews, clusters them into meaningful projects, scores and curates your capabilities, and drives an LLM agent to compose, critique, and render a resume that stays current automatically via a weekly GitHub Action.

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
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ observe  │───▶│  evolve  │───▶│  curate  │───▶│ compose  │
│ (fetch)  │    │  (LLM)   │    │ (score)  │    │  (LLM)   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
                                                      │
                ┌──────────┐    ┌──────────┐         │
                │  render  │◀───│  revise  │◀────────┘
                │  (HTML)  │    │  (LLM)   │  (optional critique loop)
                └──────────┘    └──────────┘
                      │
              data/resumes/*.html
              data/resumes/*.md
```

1. **observe** — Fetches your GitHub activity (commits, PRs, issues, reviews) via GraphQL + REST APIs.
2. **evolve** — Clusters events by project, tags capabilities, detects focus shifts, and generates structured experience entries via LLM.
3. **curate** — Merges overlapping projects, scores them by signal quality, and extracts evidence-backed capability claims.
4. **compose** — Calls the LLM once to produce a structured `ResumeDraft` (headline, summary, skills, project sections). Optionally parses a JD first and re-ranks content for the target role.
5. **critique / revise** — Iterative LLM loop: critique the draft against 5 quality dimensions, then revise based on a specific instruction.
6. **render** — Converts the draft to self-contained HTML (3 built-in styles + LLM-generated custom style) and/or Markdown.

A weekly GitHub Action runs the core pipeline automatically and opens a PR with any changes.

## CLI Commands

### Data Collection

| Command | Description |
|---------|-------------|
| `delta init [dir]` | Scaffold a new resume repo from the template |
| `delta observe` | Fetch GitHub events → `data/events/` |
| `delta evolve` | Process events → experience log + snapshot via LLM |

### Resume Agent

| Command | Description |
|---------|-------------|
| `delta curate` | Score and curate projects, extract capability claims |
| `delta compose` | Generate a structured resume draft via LLM |
| `delta compose --jd <file>` | Parse JD, re-rank content, compose a targeted draft |
| `delta critique` | LLM critique of current draft (5 quality dimensions) |
| `delta revise --instruction "<text>"` | Revise draft based on a natural language instruction |
| `delta render` | Render draft to HTML and/or Markdown |
| `delta render --style <name>` | Render with a specific HTML style |
| `delta render --style agent --instruction "<text>"` | LLM-generated custom HTML style |
| `delta styles` | List all available HTML styles |

### Legacy / Utilities

| Command | Description |
|---------|-------------|
| `delta tailor [--jd <file>]` | Legacy resume render from experience log |
| `delta lint <file>` | Check resume for banned words and structural limits |

## Resume Agent

### Basic Usage

```bash
# Collect and process GitHub activity first
delta observe
delta evolve

# Generate a general resume draft
delta compose                          # saves to data/agent/drafts/default.resume.json

# Iterate with critique and revise
delta critique                         # score draft, list issues
delta revise --instruction "make the summary more technical and concise"

# Render to HTML
delta render --style clean             # ATS-friendly (default)
delta render --style developer         # monospace accents, badge tags
delta render --style compact           # serif, two-column skills, print-ready
```

### JD-Specific Resume

```bash
# Give Delta a job description — it parses it and re-ranks your content
delta compose --jd ./job-description.txt

# The draft is automatically saved as e.g. data/agent/drafts/jd-senior-ai-engineer.resume.json
# Render it with any style
delta render --slug jd-senior-ai-engineer --style compact
```

When `--jd` is provided, `compose` runs a two-phase pipeline:
1. **Parse** the JD → structured `JdProfile` (job title, seniority, required/nice-to-have skills)
2. **Score** your projects and capability claims against those requirements (algorithmic, no extra LLM call)
3. **Compose** with JD-prioritised content and the parsed job title as the target role

### HTML Styles

| Style | Description |
|-------|-------------|
| `clean` | Dense, ATS-friendly, restrained. Good default. |
| `developer` | Monospace accents, badge tags, left-border project cards. |
| `compact` | Serif font, two-column skills, no footer. Optimised for printing one page. |
| `agent` | LLM-generated custom design. Requires `--instruction`. |

```bash
# Custom style via LLM
delta render --style agent --instruction "dark minimalist, suits an AI tools developer"
```

The agent style validates the generated HTML: checks for self-contained CSS, `@media print`, content completeness, and no external assets.

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
Yes. Use `delta render --style agent --instruction "<your design direction>"` for a fully custom LLM-generated HTML layout. For static styles, the three built-in options (clean, developer, compact) cover most needs.

**Q: How many LLM calls does the agent pipeline make?**
Typically 2–3 per full run: one for `compose`, one optional `critique`, one optional `revise`. JD parsing adds one more. Agent-style rendering adds one. All calls use your own API key.

**Q: Can I use this with GitLab/Bitbucket?**
Not yet. Multi-platform support is planned for post-v1.0.

**Q: The PR has AI-sounding language.**
Run `delta lint resume.md` to catch banned words, or run `delta critique` to get a full quality review. You can customize the banned words list in `prompts/banned_words.<lang>.txt`.

**Q: How does the JD ranking work?**
When you pass `--jd`, the JD is parsed into a structured profile (required skills, nice-to-have skills, responsibilities). Each of your projects is then scored by skill overlap. The final ordering combines the JD match score (60%) with the project's own signal quality score (40%), ensuring that JD-relevant projects surface first without ignoring evidence quality.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, commit conventions, and PR guidelines.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the data flow, module boundaries, and extension points.

## License

[AGPL-3.0-or-later](LICENSE) — see [CLA.md](CLA.md) for the contributor agreement.
