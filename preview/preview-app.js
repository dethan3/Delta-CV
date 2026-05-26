const root = document.getElementById("resume-root");
const statusEl = document.getElementById("status");
const sourcePathEl = document.getElementById("source-path");
const slugInput = document.getElementById("slug");
const styleSelect = document.getElementById("style");
const loadButton = document.getElementById("load");
const copyLinkButton = document.getElementById("copy-link");

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function detectLang(draft) {
  const sample = [
    draft.headline,
    draft.summary,
    ...(draft.skills ?? []).map((skill) => skill.category),
  ].join(" ");
  return /[\u3400-\u9fff]/.test(sample) ? "zh" : "en";
}

function labelsFor(lang) {
  if (lang === "zh") {
    return {
      summary: "总结",
      skills: "技能",
      projects: "项目经历",
      otherExperience: "其他经历",
      github: "GitHub",
    };
  }
  return {
    summary: "Summary",
    skills: "Skills",
    projects: "Projects",
    otherExperience: "Other Experience",
    github: "GitHub",
  };
}

function formatPeriod(period) {
  const from = period.from.slice(0, 7);
  const to = period.to.slice(0, 7);
  return from === to ? from : `${from} – ${to}`;
}

function renderResume(draft, style) {
  const lang = detectLang(draft);
  const labels = labelsFor(lang);
  const skills = (draft.skills ?? [])
    .map((skill) => {
      if (style === "developer") {
        return `<div class="skill-row"><strong>${esc(skill.category)}</strong><span>${esc(skill.items.join(", "))}</span></div>`;
      }
      return `<div><strong>${esc(skill.category)}:</strong> <span class="muted">${esc(skill.items.join(", "))}</span></div>`;
    })
    .join("");

  const projects = (draft.selectedProjects ?? [])
    .map((project) => {
      const bullets = (project.bullets ?? []).map((bullet) => `<li>${esc(bullet)}</li>`).join("");
      return `<article class="project">
        <div class="project-head">
          <strong>${esc(project.title)}</strong>
          <span class="project-period">${esc(formatPeriod(project.period))}</span>
        </div>
        <div class="stack">${esc((project.stack ?? []).join(" · "))}</div>
        <ul>${bullets}</ul>
      </article>`;
    })
    .join("");

  const otherExperience = (draft.otherExperience ?? []).length
    ? `<section class="section">
        <h3>${esc(labels.otherExperience)}</h3>
        <ul class="other-list">
          ${(draft.otherExperience ?? []).map((item) => `<li>${esc(item)}</li>`).join("")}
        </ul>
      </section>`
    : "";

  return `<div class="resume theme-${style}">
    <section class="hero">
      <h1>${esc(draft.login)}</h1>
      <div class="headline">${esc(draft.headline)}</div>
      <div class="muted">${esc(labels.github)}: @${esc(draft.login)}</div>
    </section>

    <section class="section">
      <h3>${esc(labels.summary)}</h3>
      <p class="summary">${esc(draft.summary)}</p>
    </section>

    <section class="section">
      <h3>${esc(labels.skills)}</h3>
      <div class="skills-grid">${skills}</div>
    </section>

    <section class="section">
      <h3>${esc(labels.projects)}</h3>
      ${projects}
    </section>

    ${otherExperience}
  </div>`;
}

function draftPathFor(slug) {
  return `../data/agent/drafts/${slug}.resume.json`;
}

function draftModulePathFor(slug) {
  return `../data/agent/drafts/${slug}.resume.js`;
}

async function loadDraftFromModule(slug) {
  const moduleUrl = new URL(draftModulePathFor(slug), window.location.href);
  moduleUrl.searchParams.set("t", String(Date.now()));
  const mod = await import(moduleUrl.href);
  return mod.default;
}

async function loadDraftFromJson(slug) {
  const response = await fetch(draftPathFor(slug), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function loadDraft() {
  const slug = slugInput.value.trim() || "default";
  const style = styleSelect.value;
  const draftPath = draftPathFor(slug);
  const modulePath = draftModulePathFor(slug);

  sourcePathEl.textContent = `${modulePath} (fallback: ${draftPath})`;
  statusEl.textContent = `Loading ${modulePath} ...`;
  root.className = "loading";
  root.textContent = "Loading draft ...";

  try {
    let draft;
    let loadedFrom = modulePath;
    try {
      draft = await loadDraftFromModule(slug);
    } catch {
      draft = await loadDraftFromJson(slug);
      loadedFrom = draftPath;
    }
    root.className = `theme-${style}`;
    root.innerHTML = renderResume(draft, style);
    statusEl.textContent = `Loaded ${loadedFrom} with style "${style}".`;

    const url = new URL(window.location.href);
    url.searchParams.set("slug", slug);
    url.searchParams.set("style", style);
    history.replaceState(null, "", url);
  } catch (error) {
    root.className = "loading";
    root.textContent = "Failed to load local draft JSON.";
    statusEl.textContent = `Load failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function applyQueryDefaults() {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get("slug");
  const style = params.get("style");
  if (slug) slugInput.value = slug;
  if (style && ["clean", "developer", "compact"].includes(style)) {
    styleSelect.value = style;
  }
}

async function copyLink() {
  const url = new URL(window.location.href);
  url.searchParams.set("slug", slugInput.value.trim() || "default");
  url.searchParams.set("style", styleSelect.value);
  try {
    await navigator.clipboard.writeText(url.toString());
    statusEl.textContent = "Preview URL copied to clipboard.";
  } catch {
    statusEl.textContent = "Could not copy URL; copy it manually from the address bar.";
  }
}

applyQueryDefaults();
loadButton.addEventListener("click", () => {
  void loadDraft();
});
styleSelect.addEventListener("change", () => {
  void loadDraft();
});
copyLinkButton.addEventListener("click", () => {
  void copyLink();
});

void loadDraft();
