# Delta CV

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

将你的 GitHub 工程活动自动转化为持续更新的简历 — 无需手动编辑，没有 AI 腔。

Delta CV 收集你的 commit、PR、issue 和 review，将其聚合成有意义的项目，提取你真实的技术栈和专注方向，并通过每周自动运行的 GitHub Action 渲染出保持最新的 Markdown 简历。

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
┌─────────┐     ┌─────────┐     ┌─────────┐
│ observe  │ ──▶ │ evolve  │ ──▶ │ tailor  │
│ (采集)   │     │ (LLM)   │     │ (渲染)   │
└─────────┘     └─────────┘     └─────────┘
    │               │               │
    ▼               ▼               ▼
 data/events/   experience.json   resume.md
 cursor.json    snapshot.json     tailored/
```

1. **observe** — 通过 GraphQL + REST API 采集你的 GitHub 活动（commit、PR、issue、review）。
2. **evolve** — 按项目聚合事件，标记技术能力，检测专注方向变化，通过 LLM 生成结构化经历条目。
3. **tailor** — 从经历日志渲染 Markdown 简历。可选地根据目标 JD 重排亮点。

每周 GitHub Action 自动运行此流程，有变更时开 PR。

## CLI 命令

| 命令 | 说明 |
|------|------|
| `delta init [dir]` | 从模板创建新的简历仓库 |
| `delta observe` | 采集 GitHub 事件 → `data/events/` |
| `delta evolve` | 处理事件 → 经历日志 + 快照（需 LLM） |
| `delta tailor [--jd <file>]` | 生成简历，可按 JD 重排 |
| `delta lint <file>` | 检查简历禁用词和结构限制 |

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

**Q: 能自定义简历模板吗？**
可以。将 `assets/resume-templates/` 拷贝到你的仓库并编辑 Eta 模板。`delta tailor` 会使用你的自定义模板。

**Q: 支持 GitLab/Bitbucket 吗？**
暂不支持。多平台支持计划在 v1.0 之后。

**Q: PR 里有 AI 腔怎么办？**
运行 `delta lint resume.md` 检查禁用词。你可以在 `prompts/banned_words.<lang>.txt` 中自定义禁用词列表。

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发环境、提交规范和 PR 流程。

## 架构

参见 [ARCHITECTURE.md](ARCHITECTURE.md) 了解数据流、模块边界和扩展点。

## 许可证

[AGPL-3.0-or-later](LICENSE) — 参见 [CLA.md](CLA.md) 了解贡献者协议。
