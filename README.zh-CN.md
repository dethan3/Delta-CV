# Delta CV

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

将你的 GitHub 工程活动转化为精准、有据可查的简历 — 无需手动编辑，没有 AI 腔。

Delta CV 收集你的 commit、PR、issue 和 review，将其聚合成有意义的项目，评分筛选你的真实技术能力，并驱动 LLM Agent 完成简历撰写、评审、修改和渲染，通过每周自动运行的 GitHub Action 保持持续更新。

> 当前状态：预发布。CLI 还没有发布到 npm，暂时请从源码构建后使用。

## 快速开始

```bash
# 1. 安装依赖并构建 CLI
pnpm install
pnpm build

# 2. 创建私有简历仓库
node dist/cli.js init my-resume
cd my-resume

# 3. 编辑 config.json — 设置你的 GitHub 用户名和 LLM 配置

# 4. 推送到 GitHub 私有仓库
git remote add origin git@github.com:<you>/my-resume.git
git push -u origin main

# 5. 在 GitHub 添加密钥（Settings → Secrets）：
#    LLM_API_KEY  — 你的 DeepSeek/OpenAI/Anthropic 密钥

# 6. 触发首次运行：
#    Actions → Delta CV → Run workflow → mode: bootstrap
```

5–15 分钟后，一个包含你生成简历的 PR 会自动出现。

## 工作原理

```text
GitHub 活动
      │
      ▼
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ observe  │───▶│  evolve  │───▶│  curate  │───▶│ compose  │
│ (采集)   │    │  (LLM)   │    │  (评分)  │    │  (LLM)   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
                                                      │
                ┌──────────┐    ┌──────────┐         │
                │  render  │◀───│  revise  │◀────────┘
                │  (HTML)  │    │  (LLM)   │  （可选 critique 循环）
                └──────────┘    └──────────┘
                      │
              data/resumes/*.html
              data/resumes/*.md
```

1. **observe** — 通过 GraphQL + REST API 采集你的 GitHub 活动（commit、PR、issue、review）。
2. **evolve** — 按项目聚合事件，标记技术能力，检测专注方向变化，通过 LLM 生成结构化经历条目。
3. **curate** — 合并相关项目，按信号质量打分，提取有据可查的技术能力声明。
4. **compose** — 调用 LLM 一次性生成结构化 `ResumeDraft`（标题、摘要、技能、项目段落）。可选先解析 JD 并为目标岗位重排内容。
5. **critique / revise** — 迭代 LLM 循环：从 5 个维度评审草稿，再按自然语言指令修改。
6. **render** — 将草稿渲染为自包含 HTML（3 种内置样式 + LLM 自定义样式）和/或 Markdown。

每周 GitHub Action 自动运行核心流程，有变更时开 PR。

## CLI 命令

### 数据采集

| 命令 | 说明 |
|------|------|
| `delta init [dir]` | 从模板创建新的简历仓库 |
| `delta observe` | 采集 GitHub 事件 → `data/events/` |
| `delta evolve` | 处理事件 → 经历日志 + 快照（需 LLM） |

### 简历 Agent

| 命令 | 说明 |
|------|------|
| `delta curate` | 项目评分筛选，提取技术能力声明 |
| `delta compose` | LLM 生成结构化简历草稿 |
| `delta compose --jd <file>` | 解析 JD，重排内容，生成岗位定向草稿 |
| `delta critique` | LLM 评审当前草稿（5 个质量维度）|
| `delta revise --instruction "<文字>"` | 按自然语言指令修改草稿 |
| `delta render` | 将草稿渲染为 HTML 和/或 Markdown |
| `delta render --style <name>` | 指定 HTML 样式渲染 |
| `delta render --style agent --instruction "<文字>"` | LLM 生成自定义 HTML 样式 |
| `delta styles` | 列出所有可用 HTML 样式 |

### 旧版 / 工具

| 命令 | 说明 |
|------|------|
| `delta tailor [--jd <file>]` | 旧版：从经历日志直接渲染简历 |
| `delta lint <file>` | 检查简历禁用词和结构限制 |

## 简历 Agent

### 基本用法

```bash
# 先采集和处理 GitHub 活动
delta observe
delta evolve

# 生成通用简历草稿
delta compose                          # 保存到 data/agent/drafts/default.resume.json

# 迭代评审和修改
delta critique                         # 评分草稿，列出问题
delta revise --instruction "摘要更技术化、更简洁"

# 渲染为 HTML
delta render --style clean             # ATS 友好（默认）
delta render --style developer         # 等宽 accent，badge 标签
delta render --style compact           # 衬线字体，双栏技能，印刷优化
```

### JD 定向简历

```bash
# 传入职位描述 — Delta 自动解析并重排你的内容
delta compose --jd ./job-description.txt

# 草稿自动保存为 data/agent/drafts/jd-senior-ai-engineer.resume.json
# 用任意样式渲染
delta render --slug jd-senior-ai-engineer --style compact
```

提供 `--jd` 时，`compose` 执行两阶段流程：
1. **解析** JD → 结构化 `JdProfile`（岗位名称、资历等级、必须/加分技能）
2. **评分** 你的项目和技术能力声明（纯算法，不额外调用 LLM）
3. **撰写** 以 JD 匹配内容优先，用解析出的岗位名作为目标角色

### HTML 样式

| 样式 | 说明 |
|------|------|
| `clean` | 紧凑、ATS 友好、克制。默认选项。|
| `developer` | 等宽 accent，badge 技术栈，左边框项目卡片。|
| `compact` | 衬线字体，双栏技能，无 footer，单页印刷优化。|
| `agent` | LLM 生成的自定义设计，需 `--instruction`。|

```bash
# 通过 LLM 生成自定义样式
delta render --style agent --instruction "深色极简风格，适合 AI 工具开发者"
```

agent 样式会验证生成的 HTML：检查自包含 CSS、`@media print`、内容完整性和无外部资源。

## 配置

编辑简历仓库中的 `config.json`：

```jsonc
{
  "login": "your-github-username",
  "language": "zh",                    // "zh"、"en" 或 "bilingual"
  "llm": {
    "provider": "openai-compatible",   // 或 "anthropic"
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat"
  },
  "ignore": {
    "repos": ["forked-repo"],
    "authors": ["dependabot[bot]", "renovate[bot]"]
  },
  "schedule": {
    "cron": "0 0 * * 1",               // 每周一
    "lookbackDays": 7
  }
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `login` | （必填） | 你的 GitHub 用户名 |
| `language` | `"zh"` | 简历输出语言 |
| `llm.provider` | `"openai-compatible"` | LLM API 提供商 |
| `llm.baseUrl` | DeepSeek URL | API 基础 URL |
| `llm.model` | `"deepseek-chat"` | 模型名称 |
| `ignore.repos` | `[]` | 排除的仓库 |
| `ignore.authors` | `[dependabot, renovate]` | 过滤的机器人作者 |
| `schedule.cron` | `"0 0 * * 1"` | Action 调度（cron 表达式） |
| `schedule.lookbackDays` | `7` | 增量模式回溯天数 |

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `LLM_API_KEY` | 是 | LLM 提供商的 API 密钥 |
| `GITHUB_TOKEN` | 自动 | GitHub Actions 自动提供；本地使用需手动设置 |
| `LLM_BASE_URL` | 否 | 覆盖 config.json 中的 llm.baseUrl |
| `LLM_MODEL` | 否 | 覆盖 config.json 中的 llm.model |

## GitHub Action

首次发布后，可以用固定 tag 从 GitHub 引用 Action：

```yaml
- uses: delta-cv/delta@v1 # 尚未发布
  with:
    mode: incremental  # 首次运行用 "bootstrap"
  env:
    LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
```

Action 执行完整的 `observe → evolve → tailor` 流程，并开 PR 更新简历。

## 隐私

- 所有处理在**你的** GitHub Actions runner 中运行。
- LLM 调用使用**你的** API 密钥 — 数据不会发送到 Delta CV 服务器。
- 默认只读**公开**仓库。使用 `include-private: true` 显式开启私有仓库读取。
- 不收集任何遥测数据。

## 常见问题

**Q: 为什么用私有仓库？**
你的简历数据是个人的。模板默认创建私有仓库。Action 完全在你的仓库内运行。

**Q: LLM 费用多少？**
每周运行通常 < $0.01（DeepSeek）。Bootstrap（3 年历史）< $0.05。

**Q: 能自定义简历样式吗？**
可以。`delta render --style agent --instruction "<你的设计方向>"` 可生成完全自定义的 LLM HTML 布局。内置的三种静态样式（clean、developer、compact）能覆盖大多数需求。

**Q: Agent 流程要调用几次 LLM？**
通常每次完整运行 2–3 次：`compose` 一次，可选的 `critique` 一次，可选的 `revise` 一次。JD 解析额外一次，agent 样式渲染额外一次。所有调用均使用你自己的 API Key。

**Q: 支持 GitLab/Bitbucket 吗？**
暂不支持。多平台支持计划在 v1.0 之后。

**Q: PR 里有 AI 腔怎么办？**
运行 `delta lint resume.md` 检查禁用词，或运行 `delta critique` 获取完整质量评审报告。你可以在 `prompts/banned_words.<lang>.txt` 中自定义禁用词列表。

**Q: JD 重排是怎么工作的？**
传入 `--jd` 时，JD 会被解析为结构化 Profile（必须技能、加分技能、岗位职责）。你的每个项目按技能重叠度打分，最终排序结合 JD 匹配度（60%）与项目自身信号质量（40%），确保 JD 相关项目优先呈现，同时不忽视证据质量。

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发环境、提交规范和 PR 流程。

## 架构

参见 [ARCHITECTURE.md](ARCHITECTURE.md) 了解数据流、模块边界和扩展点。

## 许可证

[AGPL-3.0-or-later](LICENSE) — 参见 [CLA.md](CLA.md) 了解贡献者协议。
