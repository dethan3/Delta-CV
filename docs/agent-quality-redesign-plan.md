# Delta Agent Quality Redesign Plan

## Current Status

截至当前，重构已经完成到以下阶段：

- 已完成 `EvidenceBundle` / `ProjectNarrative` / `ResumePlan` / `VerifyFactsReport` / `EvalReport` 等核心 schema
- 已完成 `delta evidence`：将现有 `ExperienceEntry` 机械桥接为 `EvidenceBundle`，不调用 LLM
- 已完成 `delta interpret`：调用 LLM 将 `EvidenceBundle[]` 解释为 `ProjectNarrative[]`
- 已完成 `delta select`：先规则 pre-filter，再调用 LLM 生成 `ResumePlan`
- 已完成 `compose` 新执行器接线：默认主链已切到 `observe -> evolve -> interpret -> select -> compose`
- 旧 `curate -> compose` 链路仍保留，可通过 `--legacy` fallback

当前新增的中间产物如下：

- `data/agent/evidence.json`
- `data/agent/narratives.json`
- `data/agent/plan.json`

当前下一步重点：

1. 补完整体验证：`typecheck` / smoke run
2. 扩充 eval fixtures 与 judge 能力
3. 根据回归结果继续收紧 prompt 与 normalization

## Background

Delta 当前的核心问题，不是“没有 Agent runtime”，而是“AI 参与的位置太靠后”。

现有流程本质上是：

`observe -> evolve -> curate -> compose -> critique/revise -> render`

其中：

- `observe` 负责采集 GitHub 活动
- `evolve` 负责把活动翻成结构化经历
- `curate` 负责规则合并、打分、提取 claims
- `compose` 才开始真正生成简历

这意味着最影响质量的决策，例如：

- 哪些活动应该被理解成同一个项目
- 哪些证据最值得上简历
- 候选人的核心职业定位是什么
- 针对 JD 时应该强调哪些能力

在当前实现里，主要靠批处理规则和字符串匹配完成，而不是由 AI 在证据层参与解释和取舍。

结论是：

- 当前效果差，部分原因确实是“批处理太多，没让 AI 参与进来”
- 但这不等于应该立即重构到 `pi-agent-core`
- 更合理的方向是：保留现有 CLI / GitHub Action / 文件型 pipeline，把 AI 前移到中段的解释、筛选、定位和对齐阶段

## Why Not Rebuild on `pi-agent-core` First

`pi-agent-core` 适合解决的问题是：

- 多轮交互式 agent loop
- 工具调用决策
- 中断恢复与事件流
- 会话态 state 管理
- 人类在环 steering

而 Delta 当前最主要的问题是：

- 中间数据结构丢失太多语义
- 规则排序过粗
- JD 匹配停留在字符串层
- 最终写作拿到的是被压缩后的劣质输入
- 没有事实验证和质量评测闭环

所以当前阶段更应该：

1. 重做中间语义层
2. 让 AI 更早参与选材和定位
3. 增加 evidence-based verification
4. 建立可回归的 eval

只有当产品目标升级成“交互式 resume copilot”时，再考虑 `pi-agent-core` 才更合理。

## Technical Diagnosis

下面按影响程度列出当前质量问题。

### 1. 过早压缩信息，导致后续写作只能在劣质摘要上润色

当前流程先按 `repo + month` 聚类，再按 `repo` 整体合并。

问题：

- 长周期项目被切成按月碎片
- 同一 repo 内的多个真实子项目被强行合并
- 项目标题容易被某一个月的局部活动代表

后果：

- 项目叙事不稳定
- 代表性贡献容易丢
- 产出的简历更像 activity digest，不像真实项目经历

### 2. AI 参与太晚，没有参与关键的解释与取舍

当前 `curate` 是纯规则阶段，不调用 LLM。

问题：

- 哪些活动属于同一条工作线，没有语义判断
- 哪些项目最值得写，没有职业叙事判断
- 哪些证据能体现 seniority / ownership / impact，没有 AI 参与提炼

后果：

- `compose` 得到的输入已经被规则层提前定型
- 最终质量上限被前置阶段锁死

### 3. 项目排序逻辑过粗，容易错选项目

当前排序主要依赖：

- highlights 数量
- activeMonths
- signalScore
- recency
- collaboration bonus

问题：

- 活跃不等于重要
- 做得久不等于适合简历
- 最近做过不等于最能代表能力
- 开源/协作标签可能把维护型项目抬得过高

后果：

- 主项目列表和真实招聘价值不一致

### 4. JD 匹配停留在字符串包含层

当前 JD scoring 基本是把项目文本拼起来做 `includes()`。

问题：

- 不理解同义表达和职责映射
- 不理解岗位想要的是“证明能力”的项目，而不是简单关键词命中

后果：

- 定岗简历更像关键词对齐，而不是岗位叙事重构

### 5. capability 分类过于 keyword-driven

当前 capability claim 主要基于关键词命中累计。

问题：

- 多面向项目会被强行压进单一类别
- confidence 不等于“适合对外表达”
- 整体候选人定位容易被关键词偏置带歪

### 6. Prompt 对 outcome 有要求，但输入证据不足

`evolve` 和 `compose` prompt 都希望 bullet 写出：

- what
- how
- outcome

但原始事件结构里，真正可靠的 outcome 信息通常并不充分。

问题：

- 模型会写得很虚
- 或者脑补结果，导致不可信

### 7. 没有证据级反查机制

虽然有 `evidenceMap`，但目前主要用于映射项目来源，没有真正做 bullet 级事实校验。

后果：

- 生成稿可能“能看”，但不一定“敢投”

### 8. 批量化优先考虑省 token，而不是叙事完整性

`evolve` 对小 cluster 做 batching，可以节约调用次数。

问题：

- 多个弱相关 cluster 会共享上下文
- 模型更容易混淆项目边界

后果：

- 摘要互相污染
- 条目失真

### 9. Prompt 更强调写法，不够强调选材与定位

当前 prompt 对格式、语气、bullet 句式要求很多，但对“为什么这个项目该出现”“候选人的主叙事是什么”约束不足。

后果：

- 输出看起来合规，但不一定有职业判断力

### 10. 缺少评测闭环

当前 `verify` 只覆盖工程正确性，不覆盖简历质量。

后果：

- 团队只能凭体验判断“好不好”
- 很难把问题归因到具体阶段
- 改完也难以验证是否真的提升

## Redesign Direction

总体方向：

**把 AI 从末端写手，前移为中段策展者。**

保留：

- 现有 CLI 入口
- GitHub Action 入口
- 文件型中间产物
- Zod schema 约束
- 现有渲染与 revise 机制

重做：

- 中间语义层
- 项目解释与分组
- 项目选择与定位
- JD 对齐
- 事实验证
- 评测体系

## Proposed New Pipeline

建议的新 pipeline：

`observe -> evolve -> interpret -> select -> compose -> verify-facts -> critique -> revise -> render`

如果有 JD：

`observe -> evolve -> interpret -> jd-parse -> jd-match -> select -> compose -> verify-facts -> critique -> revise -> render`

### Stage 1: `evolve` 变成证据整理器

目标：

- 不再过早要求模型写“像简历一样的 bullets”
- 先保留项目证据、技术动作、潜在 outcome、风险点

新增中间结构：`EvidenceBundle`

建议字段：

- `id`
- `repo`
- `period`
- `workstreamHints`
- `technicalMoves`
- `possibleOutcomes`
- `explicitEvidence`
- `uncertainClaims`
- `stack`
- `tags`

原则：

- 允许“不确定”
- 不强迫每条都写成 polished bullet
- 为后续 narrative 解释保留上下文

### Stage 2: 新增 `interpret`

目标：

- 让 AI 负责把多个 `EvidenceBundle` 解释成“简历上真正值得呈现的项目叙事”

新增中间结构：`ProjectNarrative`

建议字段：

- `projectKey`
- `title`
- `scope`
- `candidateRole`
- `coreProblem`
- `solutionShape`
- `proofPoints`
- `techStack`
- `strengthSignals`
- `riskFlags`
- `resumeWorthiness`
- `sourceEvidenceIds`

这里要解决的问题：

- 一个 repo 里其实有几个项目
- 哪些月份属于同一条工作线
- 哪些活动只是维护噪音
- 哪些叙事值得出现在简历上

### Stage 3: 新增 `select`

目标：

- 不再让 `compose` 隐式决定项目取舍
- 显式生成简历策展计划

新增结构：`ResumePlan`

建议字段：

- `positioning`
- `targetRole`
- `selectedProjectIds`
- `selectionRationale`
- `deprioritizedProjectIds`
- `skillEmphasis`
- `styleHints`

说明：

- `selectedProjectIds` 本身就是最终顺序源，不再使用平行的 `projectOrder`
- `skillEmphasis` 不是纯文案标签，而是要绑定 `supportingProjectIds`，确保每条强调能力都可回溯到已选项目

流程：

1. 规则层做预筛，给出候选 narratives
2. LLM 在候选范围内做终筛和排序
3. 明确候选人的主叙事和技能强调方向

### Stage 4: 新增 `jd-match`

目标：

- 让 JD 对齐从“字符串匹配”升级成“能力证明匹配”

建议输出：

- `projectId`
- `relevanceScore`
- `matchedRequirements`
- `adjacentStrengths`
- `bestAngle`
- `doNotOverclaim`

要回答的问题：

- 这个项目证明了 JD 的哪些能力
- 哪些能力可以相邻映射但不能硬 claim
- 应该以什么角度写这个项目

### Stage 5: `compose` 改成执行器

目标：

- `compose` 只负责把 `ResumePlan + ProjectNarrative` 写成最终稿
- 不再兼任选材器和定位器

要求：

- 输入里显式携带允许使用的 proof points
- 对 outcome 不确定的项目采用保守写法
- headline / summary 服从 `ResumePlan.positioning`

### Stage 6: 新增 `verify-facts`

目标：

- 在 `compose` 后做证据级反查

检查项：

- 每条 bullet 是否有 evidence refs 支撑
- 是否出现无法证明的 metric
- 是否出现过度 ownership claim
- 是否出现不受支持的 architecture / scale 表达

输出：

- `claims`
- `coverage`

### Stage 7: 强化 `critique`

把 `critique` 拆成两个维度：

- `editorial critique`
- `evidence critique`

这样 revise 才能同时处理：

- 语言和结构问题
- 事实与可信度问题

## Implementation Plan

建议拆成 3 个 PR。

### PR 1: 建立新中间层，不改外部命令

状态：`已完成`

目标：

- 引入 `EvidenceBundle`
- 引入 `ProjectNarrative`
- 在不破坏现有 CLI 的前提下，把新中间产物落盘

改动范围：

- 新增 `src/core/schema/evidence.ts`
- 新增 `src/core/schema/narrative.ts`
- 新增 `src/core/agent/evidence.ts`
- 新增 `src/core/agent/interpret.ts`
- 扩展 `src/core/io/data.ts` 读写接口
- 扩展 `src/core/pipeline.ts`
- 扩展 `src/cli.ts`

输出文件建议：

- `data/agent/evidence.json`
- `data/agent/narratives.json`

验收标准：

- 同一 repo 可拆分为多个 narrative
- narrative 保留 proof points / uncertain points
- 原有命令还能正常执行

完成说明：

- `PR1-A` 已完成：`delta evidence` 已可运行，桥接层严格保持机械映射、零 LLM、显式承认 lossy
- `PR1-B` 已完成：`delta interpret` 已可运行，当前为单次 LLM 调用解释全部 bundles，结果落盘到 `narratives.json`
- 当前已知技术债：
  - evidence bridge 仍然是过渡层，`explicitEvidence` / `possibleOutcomes` 仍较贫瘠
  - `interpret` 已接入 LLM，但仍需进一步增强 key 稳定性与 proof ref 收口

### PR 2: 把 AI 前移到选材和岗位对齐

状态：`已完成`

目标：

- 新增 `ResumePlan`
- 用 LLM 做项目终筛、排序和定位
- 用 LLM 做 JD 语义对齐
- `compose` 改为消费新结构

改动范围：

- 新增 `src/core/schema/plan.ts`
- 新增 `src/core/agent/select.ts`
- 新增 `src/core/agent/jd-match.ts`
- 重构 `src/core/agent/compose.ts`
- 更新 `src/core/pipeline.ts`
- 更新 `src/cli.ts`

新流程：

- 通用简历：`observe -> evolve -> interpret -> select -> compose`
- JD 简历：`observe -> evolve -> interpret -> jd-parse -> jd-match -> select -> compose`

验收标准：

- 不同 JD 下，项目入选和排序有明显变化
- `compose` 输入中显式存在定位、排序和证据使用边界
- 旧的 repo-level 合并逻辑不再主导最终成稿

完成说明：

- `PR2-A` 已完成：`delta select` 已可运行，当前流程是“规则 pre-filter + 单次 LLM 生成 ResumePlan + normalization 收口”
- `PR2-B` 已完成：`jd-match` 已可运行，产物会落盘到 `data/agent/jd-matches/<jdSlug>.json`
- `PR2-C` 已完成：`compose` 已改为消费 `ResumePlan + ProjectNarrative[]`
- `pipeline.compose()` 默认已切到新主链，旧 `curate -> compose` 通过 `--legacy` 保留 fallback
- `compose.{zh,en}.md` 已重写为“计划执行器”语义，明确服从 `positioning / selectedProjectIds / proofPoints / riskFlags`
- 当前 `ResumePlan.skillEmphasis` 已升级为可审计结构，要求每条能力绑定 `supportingProjectIds`
- 验证备注：
  - 代码接线与文档已更新，eval fixtures 已补齐最小固定样本
  - 已完成一轮本地 `typecheck` / `build` / `eval` / `verify-facts` smoke，当前基线见 `docs/smoke-regression-baseline.md`
  - 仍缺少带真实 LLM 与真实采集数据的端到端验收

### PR 3: 增加事实验证和最小评测

状态：`已完成（最小可运行版）`

目标：

- 建立 quality gate
- 建立最小可回归评测

改动范围：

- 新增 `src/core/agent/verify-facts.ts`
- 新增 `src/core/schema/eval.ts`
- 新增 `src/core/eval/*`
- 为 CLI 增加 `delta eval`
- 为 `package.json` 增加 eval script

评测维度：

- `selection_quality`
- `positioning_quality`
- `bullet_specificity`
- `fact_groundedness`
- `jd_alignment`

验收标准：

- 生成稿附带 fact warnings
- 至少有 5-10 组固定样本做回归
- prompt 或逻辑调整后可以客观比较前后质量

完成说明：

- `verify-facts` 已落地 deterministic 校验，并支持可选 LLM pass
- `compose` 默认会落盘 `verify-facts` 报告，生成稿附带 fact warnings
- CLI 已增加 `delta verify-facts` 与 `delta eval`
- `eval` 已可读取固定 fixtures、运行规则评分并产出聚合报告
- 已补 5 组固定 fixture cases，用于最小回归
- 当前实现仍以 heuristic eval 为主，后续可继续引入 judge model 强化评分质量

## Recommended Execution Order

当前建议执行顺序已经调整为：

1. `PR1-A` evidence bridge
2. `PR1-B` interpret
3. `PR2-A` select
4. `PR2-C` compose 改消费新结构
5. `PR2-B` jd-match
6. `PR3` verify-facts / eval

原因：

- 先打通非 JD 新主链，比先做 JD 匹配更重要
- 真正决定体验的是“项目如何被理解、如何被选、如何被定位”
- 不是最后一句 bullet 如何润色

当前进度对应到这个顺序：

- `PR1-A` 已完成
- `PR1-B` 已完成
- `PR2-A` 已完成
- `PR2-B` 已完成
- `PR2-C` 已完成
- `PR3` 已完成（最小可运行版）

## Non-Goals For Now

当前阶段不建议优先做：

- 重构到 `pi-agent-core`
- 重做 HTML 风格系统
- 单纯继续堆 prompt，不改中间结构
- 只微调 `compose` 而不改前置阶段

## Success Criteria

如果这个重构方向是正确的，应该看到这些变化：

- 简历更像“有判断力的职业叙事”，而不是 GitHub 活动摘要
- 主项目选择更稳定，更符合招聘价值
- JD 定制结果更像“岗位对齐”，而不是关键词改写
- bullet 更具体，但更少虚构 outcome
- 用户会更敢直接使用输出，而不是只把它当草稿
- 质量改动可以通过 eval 量化，而不是只能凭主观体验判断
