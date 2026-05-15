import type { ResumeDraft } from "../schema/agent.ts";
import { esc, formatPeriod } from "./utils.ts";

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --text: #111;
    --muted: #555;
    --border: #ccc;
    --accent: #1d4ed8;
    --bg: #fff;
  }

  body {
    font-family: "Times New Roman", Times, serif;
    font-size: 10.5pt;
    line-height: 1.38;
    color: var(--text);
    background: var(--bg);
    max-width: 760px;
    margin: 0 auto;
    padding: 1.8rem 1.6rem 1rem;
  }

  /* ── Header ── */
  .resume-header {
    text-align: center;
    border-bottom: 1.5px solid var(--text);
    padding-bottom: 0.4rem;
    margin-bottom: 0.7rem;
  }
  .resume-header h1 {
    font-size: 1.45rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 0.15rem;
  }
  .headline {
    font-size: 0.82rem;
    color: #333;
    font-style: italic;
    margin-bottom: 0.15rem;
  }
  .meta { font-size: 0.76rem; color: var(--muted); }

  /* ── Sections ── */
  section { margin-bottom: 0.65rem; }
  section h2 {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    border-bottom: 0.75px solid var(--text);
    padding-bottom: 0.1rem;
    margin-bottom: 0.45rem;
  }

  /* ── Summary ── */
  .summary { font-size: 0.83rem; line-height: 1.45; }

  /* ── Skills ── */
  .skills-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.1rem 1.5rem;
  }
  .skill-row { font-size: 0.78rem; display: flex; gap: 0.3rem; }
  .skill-cat { font-weight: 700; flex-shrink: 0; }
  .skill-cat::after { content: ":"; }
  .skill-items { color: #333; }

  /* ── Projects ── */
  .project { margin-bottom: 0.7rem; }
  .project-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.2rem;
  }
  .project-title { font-size: 0.83rem; font-weight: 700; }
  .project-period { font-size: 0.75rem; color: var(--muted); font-style: italic; }
  .project-stack { font-size: 0.74rem; color: var(--muted); margin: 0.1rem 0 0.25rem; }
  .project ul { padding-left: 1rem; }
  .project li { font-size: 0.79rem; margin-bottom: 0.1rem; line-height: 1.4; }

  /* ── Other Experience ── */
  .other-list { padding-left: 1rem; list-style: disc; }
  .other-list li { font-size: 0.77rem; margin-bottom: 0.08rem; }

  /* ── Print ── */
  @media print {
    body { padding: 0.8cm 1.2cm 0.6cm; max-width: 100%; }
    section { break-inside: avoid; }
    .project { break-inside: avoid; }
    a { color: inherit; text-decoration: none; }
  }

  @media (max-width: 600px) {
    body { padding: 0.8rem; }
    .skills-grid { grid-template-columns: 1fr; }
    .project-header { flex-direction: column; }
  }
`.trim();

function renderSkills(draft: ResumeDraft): string {
  if (draft.skills.length === 0) return "";
  const rows = draft.skills
    .map(
      (g) => `<div class="skill-row">
      <span class="skill-cat">${esc(g.category)}</span>
      <span class="skill-items">${esc(g.items.join(", "))}</span>
    </div>`,
    )
    .join("\n    ");
  return `
  <section>
    <h2>Technical Skills</h2>
    <div class="skills-grid">
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
      const stack = p.stack.slice(0, 5).map(esc).join(", ");
      return `<div class="project">
      <div class="project-header">
        <span class="project-title">${esc(p.title)}</span>
        <span class="project-period">${esc(period)}</span>
      </div>
      <div class="project-stack">${stack}</div>
      <ul>${bullets}</ul>
    </div>`;
    })
    .join("\n    ");
  return `
  <section>
    <h2>Selected Projects</h2>
    ${blocks}
  </section>`;
}

function renderOtherExperience(draft: ResumeDraft): string {
  if (draft.otherExperience.length === 0) return "";
  const items = draft.otherExperience.slice(0, 4).map((e) => `<li>${esc(e)}</li>`).join("\n      ");
  return `
  <section>
    <h2>Additional</h2>
    <ul class="other-list">
      ${items}
    </ul>
  </section>`;
}

/**
 * Render a ResumeDraft into a compact, print-optimised single-page HTML file.
 * Serif font, dense spacing, centred header — classic academic/professional style.
 */
export function renderResumeDraftHtmlCompact(draft: ResumeDraft): string {
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
    <h1>${esc(draft.login)}</h1>
    <div class="headline">${esc(draft.headline)}</div>
    <div class="meta">github.com/${esc(draft.login)}</div>
  </header>

  <section>
    <h2>Summary</h2>
    <p class="summary">${esc(draft.summary)}</p>
  </section>
${renderSkills(draft)}
${renderProjects(draft)}
${renderOtherExperience(draft)}
</body>
</html>`;
}
