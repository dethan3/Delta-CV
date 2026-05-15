import type { ResumeDraft } from "../schema/agent.ts";
import { esc, formatPeriod } from "./utils.ts";

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --text: #1a1a1a;
    --muted: #6b7280;
    --border: #e2e8f0;
    --accent: #0ea5e9;
    --accent-dim: #e0f2fe;
    --green: #10b981;
    --bg: #fff;
    --bg-code: #f8fafc;
    --font-sans: "Inter", "Helvetica Neue", Arial, sans-serif;
    --font-mono: "JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace;
    --section-gap: 1.5rem;
  }

  body {
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.6;
    color: var(--text);
    background: var(--bg);
    max-width: 860px;
    margin: 0 auto;
    padding: 2.5rem 2.2rem;
  }

  /* ── Header ── */
  .resume-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: calc(var(--section-gap) + 0.4rem);
    padding-bottom: 1rem;
    border-bottom: 2px solid var(--accent);
  }
  .header-left {}
  .resume-header h1 {
    font-family: var(--font-mono);
    font-size: 1.7rem;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: #0f172a;
    margin-bottom: 0.2rem;
  }
  .header-prompt {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--accent);
    margin-bottom: 0.4rem;
  }
  .header-prompt::before { content: "$ "; color: var(--green); }
  .headline {
    font-size: 0.93rem;
    color: #334155;
    font-weight: 500;
    max-width: 55ch;
  }
  .meta { font-size: 0.78rem; color: var(--muted); margin-top: 0.4rem; }

  /* ── Sections ── */
  section { margin-bottom: var(--section-gap); }
  section h2 {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--accent);
    border-left: 3px solid var(--accent);
    padding-left: 0.6rem;
    margin-bottom: 0.9rem;
  }

  /* ── Summary ── */
  .summary {
    font-size: 0.91rem;
    color: #334155;
    max-width: 70ch;
    line-height: 1.65;
  }

  /* ── Skills ── */
  .skills-list { display: flex; flex-direction: column; gap: 0.45rem; }
  .skill-row { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
  .skill-cat {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text);
    min-width: 14ch;
    flex-shrink: 0;
  }
  .skill-cat::after { content: ":"; }
  .skill-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .tag {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    background: var(--bg-code);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0.1rem 0.4rem;
    color: #0f172a;
  }

  /* ── Projects ── */
  .project { margin-bottom: 1.3rem; padding-left: 0.75rem; border-left: 2px solid var(--border); }
  .project:hover { border-left-color: var(--accent); }
  .project-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-bottom: 0.15rem;
  }
  .project-title {
    font-family: var(--font-mono);
    font-size: 0.88rem;
    font-weight: 700;
    color: #0f172a;
  }
  .project-title::before { content: "./"; color: var(--green); }
  .project-period {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--muted);
  }
  .project-stack { display: flex; flex-wrap: wrap; gap: 0.25rem; margin: 0.3rem 0 0.5rem; }
  .project ul { padding-left: 1rem; }
  .project li {
    font-size: 0.86rem;
    margin-bottom: 0.25rem;
    line-height: 1.55;
    color: #334155;
  }

  /* ── Other Experience ── */
  .other-list { list-style: none; padding: 0; }
  .other-list li {
    font-size: 0.83rem;
    margin-bottom: 0.25rem;
    color: var(--muted);
    padding-left: 1rem;
    position: relative;
  }
  .other-list li::before { content: "▸"; position: absolute; left: 0; color: var(--accent); }

  /* ── Footer ── */
  .resume-footer {
    margin-top: 2rem;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: #cbd5e1;
    text-align: right;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
  }

  /* ── Print ── */
  @media print {
    body { padding: 0.5cm 1cm; max-width: 100%; font-size: 10.5pt; }
    .resume-footer { display: none; }
    .project { break-inside: avoid; }
    a { color: inherit; text-decoration: none; }
    .project:hover { border-left-color: var(--border); }
  }

  @media (max-width: 600px) {
    body { padding: 1rem; }
    .resume-header { flex-direction: column; }
    .skill-cat { min-width: auto; }
  }
`.trim();

function renderSkills(draft: ResumeDraft): string {
  if (draft.skills.length === 0) return "";
  const rows = draft.skills
    .map((g) => {
      const tags = g.items
        .slice(0, 10)
        .map((t) => `<span class="tag">${esc(t)}</span>`)
        .join("");
      return `<div class="skill-row">
      <span class="skill-cat">${esc(g.category)}</span>
      <div class="skill-tags">${tags}</div>
    </div>`;
    })
    .join("\n    ");
  return `
  <section>
    <h2>Skills</h2>
    <div class="skills-list">
    ${rows}
    </div>
  </section>`;
}

function renderProjects(draft: ResumeDraft): string {
  if (draft.selectedProjects.length === 0) return "";
  const blocks = draft.selectedProjects
    .map((p) => {
      const period = formatPeriod(p.period.from, p.period.to);
      const bullets = p.bullets.map((b) => `<li>${esc(b)}</li>`).join("\n        ");
      const tags = p.stack
        .slice(0, 6)
        .map((t) => `<span class="tag">${esc(t)}</span>`)
        .join("");
      return `<div class="project">
      <div class="project-header">
        <span class="project-title">${esc(p.title)}</span>
        <span class="project-period">${esc(period)}</span>
      </div>
      <div class="project-stack">${tags}</div>
      <ul>${bullets}</ul>
    </div>`;
    })
    .join("\n    ");
  return `
  <section>
    <h2>Projects</h2>
    ${blocks}
  </section>`;
}

function renderOtherExperience(draft: ResumeDraft): string {
  if (draft.otherExperience.length === 0) return "";
  const items = draft.otherExperience.map((e) => `<li>${esc(e)}</li>`).join("\n      ");
  return `
  <section>
    <h2>Other Experience</h2>
    <ul class="other-list">
      ${items}
    </ul>
  </section>`;
}

/**
 * Render a ResumeDraft into a developer-style self-contained HTML file.
 * Monospace accents, badge stack tags, left-border project cards.
 */
export function renderResumeDraftHtmlDeveloper(draft: ResumeDraft): string {
  const date = draft.generatedAt.slice(0, 10);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(draft.login)} — Resume</title>
  <style>${CSS}</style>
</head>
<body>
  <header class="resume-header">
    <div class="header-left">
      <h1>${esc(draft.login)}</h1>
      <div class="header-prompt">${esc(draft.headline)}</div>
      <div class="meta">github.com/${esc(draft.login)}</div>
    </div>
  </header>

  <section>
    <h2>Summary</h2>
    <p class="summary">${esc(draft.summary)}</p>
  </section>
${renderSkills(draft)}
${renderProjects(draft)}
${renderOtherExperience(draft)}

  <footer class="resume-footer">// generated by delta-cv · ${esc(date)}</footer>
</body>
</html>`;
}
