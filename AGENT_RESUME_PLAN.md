# Agent Resume Development Plan

## Goal

Delta CV should evolve from an activity-to-resume pipeline into a personal resume agent.

The product should not merely list GitHub activity. It should maintain a durable evidence base, select the strongest work, synthesize a candidate positioning, write a polished resume, support iterative refinement, and generate presentation-ready HTML in multiple styles.

## Current State

Implemented:

- GitHub activity collection through GraphQL and REST APIs.
- Event storage under `data/events/`.
- LLM-based per-cluster experience extraction into `data/_meta/experience.json`.
- Snapshot generation with tags and focus trends.
- Markdown resume rendering through static templates.
- Basic lint checks for banned words, line length, and section structure.

Observed gaps:

- The final resume is still too close to an activity ledger.
- `tailor` mostly sorts or renders; it does not act as a resume editor.
- Weak entries such as initial commits and minor UI fixes are not reliably downranked.
- Repeated work across months or repositories is not merged into a coherent project story.
- There is no candidate positioning, target-role strategy, or narrative rewrite stage.
- HTML output is not yet part of the product flow.
- Users cannot ask for iterative changes such as "make it more senior", "focus on AI", or "shorten to one page".

## Product Direction

Reposition the product as:

> Delta CV: a personal resume agent that continuously turns real engineering activity into polished, evidence-backed resumes.

The core product loop should become:

```text
observe -> evolve -> curate -> compose -> critique -> revise -> render
```

Where:

- `observe` collects evidence.
- `evolve` turns raw events into structured experience entries.
- `curate` selects, merges, downranks, and classifies entries.
- `compose` writes a polished resume from selected evidence.
- `critique` checks whether the resume is actually usable.
- `revise` applies requested or automatic improvements.
- `render` outputs Markdown, HTML, and later PDF.

## Architecture

### Data Model Additions

Add durable agent state under `data/agent/`:

```text
data/agent/
  profile.json          Candidate positioning and preferred role targets
  projects.json         Consolidated project memory
  claims.json           Evidence-backed capability claims
  drafts/
    default.resume.json Structured resume draft
    jd-<slug>.json      JD-specific structured draft
  critiques/
    default.json        Agent critique and revision notes
```

Recommended schemas:

- `CandidateProfile`
  - `headline`
  - `targetRoles`
  - `seniority`
  - `corePositioning`
  - `preferredLanguage`
  - `avoidClaims`

- `ProjectMemory`
  - `id`
  - `title`
  - `repos`
  - `period`
  - `category`
  - `importance`
  - `evidenceEntryIds`
  - `summary`
  - `strongBullets`
  - `weakSignals`

- `CapabilityClaim`
  - `claim`
  - `category`
  - `evidence`
  - `confidence`
  - `resumeUse`

- `ResumeDraft`
  - `headline`
  - `summary`
  - `skills`
  - `selectedProjects`
  - `otherExperience`
  - `openSource`
  - `evidenceMap`
  - `styleNotes`

### New Commands

Add these CLI commands:

```bash
delta curate
delta compose
delta critique
delta revise --instruction "更突出 AI Agent 工程能力"
delta render --format html --style clean
delta styles
```

Possible combined command:

```bash
delta resume --since 2026-01-01 --target "AI 工程师 / 全栈工程师" --format html
```

## Agent Workflow

### 1. Curate

Input:

- `data/_meta/experience.json`
- latest snapshot
- optional user profile
- optional target role or JD

Responsibilities:

- Merge repeated entries for the same project across months.
- Downrank weak activity:
  - initial commits
  - dependency bumps
  - minor UI fixes
  - pure documentation changes, unless documentation is part of the target positioning
- Identify strong signals:
  - shipped systems
  - measurable performance improvements
  - architecture or refactoring work
  - API integrations
  - automation workflows
  - AI or agent tooling
  - open-source/community impact
- Produce `projects.json` and `claims.json`.

### 2. Compose

Input:

- curated project memory
- capability claims
- target role or JD

Responsibilities:

- Write a resume that is not a timeline.
- Generate a strong headline.
- Write a concise professional summary.
- Select 4-6 strongest projects.
- Write 2-4 bullets per selected project.
- Group skills by capability, not just alphabetically.
- Keep evidence mapping so every claim can be traced to activity.

Output:

- `data/agent/drafts/default.resume.json`

### 3. Critique

Responsibilities:

- Detect if the resume still reads like an activity log.
- Check if the strongest projects appear first.
- Flag vague claims, weak verbs, unsupported metrics, and overclaiming.
- Check whether the target role is obvious in the first viewport.
- Check length and density.

Output:

- `data/agent/critiques/default.json`

### 4. Revise

Support user instructions such as:

- "更偏 AI 工程师"
- "更像高级全栈工程师"
- "减少开源内容，突出产品落地"
- "压缩到一页"
- "语气更专业，少一点宣传感"
- "把 Flowlingo 放前面"
- "生成英文版"

The revise step should update the structured draft, not directly patch raw HTML.

### 5. Render

Render structured drafts into:

- HTML
- Markdown
- later PDF

Rendering should not decide what content belongs in the resume. It should only apply layout and style.

## HTML Template System

Add built-in styles:

```text
clean       Dense, ATS-friendly, restrained visual style
executive   Strong summary, fewer projects, more senior positioning
developer   Project-heavy, technical details and evidence-forward
portfolio   More visual, suitable for personal site
compact     One-page print-oriented layout
```

Command examples:

```bash
delta render --format html --style clean
delta render --format html --style developer
delta render --format html --style compact
```

If none of the templates are satisfactory, support agent-generated style:

```bash
delta render --format html --style agent --instruction "做成深色极简风格，适合 AI 工具开发者"
```

Rules for agent-generated HTML:

- Must be self-contained.
- No remote assets by default.
- Must include responsive layout.
- Must include print CSS.
- Must preserve all evidence-backed content from the structured draft.
- Must not invent experience or metrics.

## Fine-Tuning And Polishing

Polishing should be an explicit product feature, not an accidental prompt tweak.

Supported operations:

```bash
delta revise --instruction "突出开源影响力"
delta revise --instruction "改成更适合 AI Agent 工程岗位"
delta revise --instruction "弱化小项目，只保留 5 个代表项目"
delta revise --instruction "把语气改得更像资深工程师"
delta revise --instruction "英文版，面向 Developer Tooling 岗位"
```

Internally, polishing should preserve:

- structured draft
- revision instruction
- before/after diff
- evidence map

This allows the product to show why the resume changed.

## Milestones

### M1: Manual Agent Prototype

Goal: Validate the final-resume quality before building a full framework.

Tasks:

- Use existing `experience.json`.
- Manually implement a script or command that creates a curated HTML resume.
- Select 5-6 strong projects.
- Produce one clean HTML template.
- Compare output against current `tailor` Markdown.

Success criteria:

- Output no longer reads like a timeline.
- Weak entries are not in the main project section.
- Resume has a clear candidate positioning.
- HTML can be opened directly in a browser.

### M2: Structured Resume Draft

Goal: Add a real intermediate representation for resumes.

Tasks:

- Add `ResumeDraftSchema`.
- Add `curate` command.
- Add `compose` command.
- Save `data/agent/drafts/default.resume.json`.
- Add tests for schema validation and evidence references.

Success criteria:

- Resume content can be inspected and revised before rendering.
- Every project bullet has evidence references.

### M3: Critique And Revise Loop

Goal: Make the agent self-improving.

Tasks:

- Add critique prompt.
- Add revise prompt.
- Add `delta critique`.
- Add `delta revise --instruction`.
- Store critiques and revision history.

Success criteria:

- The system can identify "too much activity list" as a failure.
- User instructions can reshape the resume without rerunning `observe` or `evolve`.

### M4: HTML Style Templates

Goal: Make generated resumes presentable.

Tasks:

- Add built-in HTML renderers:
  - `clean`
  - `developer`
  - `compact`
- Add style preview command.
- Add responsive and print checks.

Success criteria:

- HTML output is usable as a personal site page or print source.
- User can switch style without changing content.

### M5: Agent-Generated HTML

Goal: Support custom visual direction when built-in styles are not enough.

Tasks:

- Add `--style agent`.
- Add design constraints for self-contained HTML.
- Add guardrails against invented content.
- Validate generated HTML contains all required sections.

Success criteria:

- User can ask for a custom visual style.
- Generated style remains faithful to structured resume content.

### M6: JD-Specific Resume Agent

Goal: Make `tailor --jd` produce a real targeted resume.

Tasks:

- Parse JD into target requirements.
- Score claims and projects against JD.
- Compose a JD-specific draft.
- Revise tone and project order for the JD.
- Render to HTML/Markdown.

Success criteria:

- Different JDs produce materially different emphasis.
- The resume remains evidence-backed and does not invent unsupported claims.

## Testing Strategy

Unit tests:

- schemas for profile, project memory, claims, and resume draft
- project merging and downranking rules
- evidence reference validation

Golden tests:

- fixed `experience.json` input
- expected curated project set
- expected structured resume shape

LLM tests:

- mocked LLM responses for schema conformance
- fixture-based compose and revise tests

HTML tests:

- validate required sections exist
- validate no remote assets in default templates
- validate print CSS exists
- optional browser screenshot for template regressions

Quality checks:

- no unsupported claims
- no forbidden resume clichés
- not more than 6 main projects
- no activity-log section as the primary body

## Immediate Next Step

Build M1 as a prototype:

```bash
delta compose --from data/_meta/experience.json --format html --style clean
```

For now, this can be implemented without changing the full pipeline:

- read `experience.json`
- apply simple scoring and grouping rules
- call one LLM compose prompt
- write `data/resumes/default.html`

Once the output quality is clearly better than current `tailor`, promote it into the main product flow.
