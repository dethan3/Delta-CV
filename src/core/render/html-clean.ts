import type { ResumeDraft } from "../schema/agent.ts";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPeriod(from: string, to: string): string {
  const f = from.slice(0, 7);
  const t = to.slice(0, 7);
  return f === t ? f : `${f} – ${t}`;
}

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --text: #1a1a1a;
    --muted: #555;
    --border: #d0d0d0;
    --accent: #2563eb;
    --bg: #fff;
    --section-gap: 1.6rem;
    --font: "Inter", "Helvetica Neue", Arial, sans-serif;
  }

  body {
    font-family: var(--font);
    font-size: 14px;
    line-height: 1.55;
    color: var(--text);
    background: var(--bg);
    max-width: 820px;
    margin: 0 auto;
    padding: 2.4rem 2rem;
  }

  /* ── Header ── */
  .resume-header { margin-bottom: var(--section-gap); }
  .resume-header h1 {
    font-size: 1.8rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin-bottom: 0.25rem;
  }
  .headline {
    font-size: 1rem;
    color: var(--accent);
    font-weight: 500;
    margin-bottom: 0.5rem;
  }
  .meta { font-size: 0.82rem; color: var(--muted); }

  /* ── Sections ── */
  section { margin-bottom: var(--section-gap); }
  section h2 {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.3rem;
    margin-bottom: 0.9rem;
  }

  /* ── Summary ── */
  .summary { font-size: 0.92rem; color: #333; max-width: 68ch; }

  /* ── Skills ── */
  .skills-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 0.5rem 1.5rem;
  }
  .skill-group { font-size: 0.85rem; }
  .skill-group .cat { font-weight: 600; color: var(--text); }
  .skill-group .items { color: var(--muted); }

  /* ── Projects ── */
  .project { margin-bottom: 1.2rem; }
  .project-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .project-title { font-size: 0.95rem; font-weight: 600; }
  .project-meta { font-size: 0.78rem; color: var(--muted); white-space: nowrap; }
  .project-stack {
    font-size: 0.75rem;
    color: var(--muted);
    margin: 0.2rem 0 0.45rem;
  }
  .project ul { padding-left: 1.1rem; }
  .project li {
    font-size: 0.87rem;
    margin-bottom: 0.22rem;
    line-height: 1.5;
  }

  /* ── Other Experience ── */
  .other-list { list-style: disc; padding-left: 1.1rem; }
  .other-list li { font-size: 0.85rem; margin-bottom: 0.2rem; color: #333; }

  /* ── Footer ── */
  .resume-footer {
    margin-top: 2rem;
    font-size: 0.75rem;
    color: #aaa;
    text-align: right;
    border-top: 1px solid var(--border);
    padding-top: 0.6rem;
  }

  /* ── Print ── */
  @media print {
    body { padding: 0; max-width: 100%; font-size: 11pt; }
    .resume-footer { display: none; }
    section { break-inside: avoid; }
    .project { break-inside: avoid; }
    a { color: inherit; text-decoration: none; }
  }

  @media (max-width: 600px) {
    body { padding: 1.2rem 1rem; }
    .skills-grid { grid-template-columns: 1fr; }
    .project-header { flex-direction: column; }
  }
`.trim();

function renderSkills(draft: ResumeDraft): string {
  if (draft.skills.length === 0) return "";
  const rows = draft.skills
    .map(
      (g) =>
        `<div class="skill-group"><span class="cat">${esc(g.category)}: </span><span class="items">${esc(g.items.join(", "))}</span></div>`,
    )
    .join("\n      ");
  return `
  <section>
    <h2>Skills</h2>
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
      const stack = p.stack.slice(0, 6).map(esc).join(" · ");
      return `<div class="project">
      <div class="project-header">
        <span class="project-title">${esc(p.title)}</span>
        <span class="project-meta">${esc(period)}</span>
      </div>
      <div class="project-stack">${stack}</div>
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
 * Render a ResumeDraft into a self-contained clean HTML file.
 * No external assets — all CSS is inline. Includes responsive layout and print CSS.
 */
export function renderResumeDraftHtml(draft: ResumeDraft): string {
  const date = draft.generatedAt.slice(0, 10);

  return `<!DOCTYPE html>
<html lang="${draft.login ? "zh" : "en"}">
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
    <div class="meta">GitHub: @${esc(draft.login)}</div>
  </header>

  <section>
    <h2>Summary</h2>
    <p class="summary">${esc(draft.summary)}</p>
  </section>
${renderSkills(draft)}
${renderProjects(draft)}
${renderOtherExperience(draft)}

  <footer class="resume-footer">Generated by Delta CV · ${esc(date)}</footer>
</body>
</html>`;
}
