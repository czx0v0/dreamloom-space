# 筑梦之境 / Dreamloom · 项目介绍

> 一个 LLM 驱动的互动叙事工作台：你给一个世界，它一幕一幕往下写；写的同时有人在旁边记笔记，
> 你可以回退、改设定、导出成稿，也可以钻进那个世界里走两步。

---

## 一、背景：为什么做这个

单人用 LLM 写长故事，会在第 10–20 幕之间崩掉，崩的方式很固定：

| 症状 | 根因 |
|---|---|
| 人物前后不一致、死人复活 | 模型每次只看到"最近几段"，没有可信的档案 |
| 细节对不上（信的颜色、仓库的位置） | 摘要链丢细节，且没有检索 |
| 越写越平，没有终点 | 没有目标、阶段与收束机制，模型只会"继续" |
| 选项像同一句话的三种说法 | 选项没有意图结构，也不改变状态 |
| 改 prompt 之后不知道是变好还是变坏 | 没有可复现的实测方法，全靠手感 |

这些不是"模型不够强"，而是**记忆、约束、可测性**三件事没做。Dreamloom 的目标是把它们做成结构。

## 二、目标

1. **能写完**：25–30 幕内有阶段推进与结局，不是无限续写。
2. **不崩设定**：每一幕的抽取都要过 evidence 校验，宁可漏记不可错记。
3. **能改**：回退、压缩、重写、手改锁定，且改完时间线自洽。
4. **可测**：剧情质量有 harness、抽取质量有 eval，改一处只动一个变量。
5. **可迁移**：数据在浏览器、存档是 JSON、模型可换（DeepSeek / 百炼 / 自定义）。

## 三、设计行动

### 3.1 分层：纯逻辑、编排、IO 三段切开

```
domain/   纯函数：类型、补丁、校验、预算、检索、导出   ← 全部有单测，不碰 IO
app/      编排：推进一幕、建空间、回退、抽取同步        ← 只依赖端口
store/    仓储：KV 抽象 + IndexedDB 适配 + 行级读写
agents/   端口：叙事 / 档案员 / 校对 / 改写 / 生成
server/   服务端：代理、SSE、限流、prompt（唯一 prompt 源）
ui/       React 页面：书架 / 编织台 / 档案 / 时间线 / 导出 / 入梦
```

关键取舍：**不用 LangChain/LangGraph**。没有路由需求，框架会把 prompt 藏起来，
兼容层反而增加故障面；全部自己写，prompt 可单测、可 diff。

### 3.2 记忆分三层，各管一段

| 层 | 存什么 | 谁写 | 谁读 |
|---|---|---|---|
| 摘要链 | 每幕一句话 | 档案员 | 大纲、检索 |
| 实体记忆 | 人物故事线 `arc`、地点事件 `place.events`、事实账 `Fact` | 档案员（evidence 校验） | 上下文装配 |
| 细节召回 | 分词块 + 关键词/向量 | 后台增量 | 装配时按需取 |

为什么不做"摘要的摘要"：压缩会改写因果且不可追溯，错误会复利。

### 3.3 多 Agent，但不互相调用

| Agent | 触发 | 失败影响 |
|---|---|---|
| 叙事 | 玩家行动 | 可重试，不写库 |
| 档案员 | 幕提交后 | 水位不前进，下一幕照常 |
| 收线校对 | 与档案员并行 | 这次没收线，不影响正文 |
| 生成（事件/秘密） | 用户点按钮 | 只提示，不阻塞手写 |

**收线校对**是实测逼出来的：档案员忙着记新信息，36 幕里一次都没收过线。
把"这一幕回答了哪些旧问题"拆成独立的窄任务（温度 0、编号 + 原句校验），才有稳定回收。

### 3.4 玩法闭环：选项、判定、事件、终局

- 4 个选项，带 `追问/行动/观察/离开` 标签，至少一条改变状态；
- 每步可选**稳妥/冒险**，代码先掷骰（0.86 / 0.56 + 能力与同伴加成），模型只负责把结果写像；
- 固定事件到期出「应对卡」，玩家选姿态后进判定；
- 目标 → 阶段 → 结局三道闸：`opening → investigation → climax → ending → closed`；
- 线索两段式（已知 + 待答），可主动「追这条」，久悬自动放下（单列，不伪装成已解答）。

### 3.5 可测性：两把尺子

| 尺子 | 量什么 | 怎么跑 |
|---|---|---|
| `npm run eval` | 抽取质量：evidence 忠实度 / schema / 幻觉 / 复活 | 20 例真实翻车场景，四项门禁 |
| `PLAYTEST=1 npx vitest run tests/live` | 剧情质量：重复率 / 字数 / 收线 / 阶段 / 耗时 | 真服务端跑 12–25 幕，产出报告 |

## 四、结果与产出

- **471 例单测全绿**（38 文件），`tsc` 干净，构建 305KB / gzip 106KB。
- **eval 门禁 PASS**：evidence 1.00、schema 1.00、幻觉 0.03、复活 0。
- **实测（16 幕）**：选项 4 条全覆盖、区分度 100%、字数均值 259（超上限 6%）、抽取 100%、
  收线 2 条、久悬自动放下 2 条、单幕 p95 7.4s。
- **25 幕长跑**：跑到 climax，4 个地点、6 个人物，字数超限降到 16%。
- 线上实例（BYOK）：`https://dreamloom-story.app.workbuddy.host/?sharecode=WWESA3ZD2O`

## 五、架构

```mermaid
flowchart TB
  subgraph UI[浏览器 · React]
    P[编织台 Play] --- C[档案 Codex] --- T[时间线] --- E[导出] --- D[入梦]
  end

  subgraph APP[编排层 app/]
    A1[advanceScene 推进一幕]
    A2[pack 上下文装配]
    A3[rollback 回退]
  end

  subgraph DOM[纯逻辑 domain/]
    D1[patch 补丁] --- D2[validate 校验] --- D3[budget 预算]
    D4[clue / triage 线索] --- D5[export 渲染]
  end

  subgraph STORE[存储]
    S1[(IndexedDB 单库)] --- S2[repo 行级读写] --- S3[快照 / 回退]
  end

  subgraph SRV[服务端 Node 单端口]
    V1[/api/narrate SSE/]
    V2[/api/archive]
    V3[/api/triage]
    V4[/api/suggest · dream]
    V5[prompts 唯一 prompt 源]
    V6[guard 限流 / 额度]
  end

  LLM[(DeepSeek / 百炼 / 自定义)]
  UI --> APP --> DOM
  APP --> STORE
  APP -->|fetch| SRV --> LLM
```

### 一次推进的时序

```
玩家行动（选项 / 自述 / 事件应对，带稳妥或冒险）
  → 代码掷判定，把"结果指令"写进行动上下文
  → pack 按预算装配：世界/铁律/目标/人物/地点/线索/事实/召回/上一幕尾巴
  → /api/narrate 流式出文（SSE，rAF 批量渲染）
  → audit 审计（死角色行动、未知人名、字数）
  → 提交 Scene(committed) → 立刻抽取（并行：档案员 + 收线校对）
  → 档案落库（evidence 校验、上限与去重）→ 幕间最多等 8s → 解禁下一幕
```

### 数据形状

```
SpaceMeta  空间：模式、目标、阶段、固定事件、字数档
CanonState 档案：世界 / 人物 / 地点 / 关系 / 事实
Scene      幕：正文（分行存）、选项、位置、在场、摘要、线索
PatchRecord 补丁：ops + report + raw（回退与审计的物理基础）
```

## 六、取舍与还没做的

| 项 | 现状 | 原因 |
|---|---|---|
| 物品系统 | 无 `Item` 表；用事实 `持有/位于` 表达 | 叙事阶段够用；背包要解决归属与同步，留到入梦完整版 |
| 入梦 | 最小版四动词，**不写回主线档案** | 先能走两步；写回需要显式协议，不能悄悄发生 |
| 生图 / 语音 | 只有端口与开关，未实现 | 要接图像/语音供应商并处理额度与缓存，单独一轮 |
| 向量召回 | 只有关键词档 | 先验证关键词够不够；向量包体与首屏成本另算 |
| 回退 | 破坏性删除后移的幕 | 孤儿占编号会导致"退了没退干净"；留档交给导出 |

## 七、快速开始

```bash
npm install
cp .env.example .env.local   # 填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
npm run dev:api              # 服务端 :3000
npm run dev                  # 前端 :5173
npm test                     # 471 例
npm run eval                 # 需要服务端在跑
```

线上版不带服务端 Key：打开链接 → 设置 → 填自己的 Key（只存本机）→ 回书架新建空间。

## 八、命名

| 场景 | 名称 |
|---|---|
| 中文全称 | **筑梦之境 · 沉浸式故事体验** |
| 中文短名 | 筑梦之境 |
| 英文名 | **Dreamloom Space** |
| 英文副标 | Immersive Story Experience |

为什么是 `Dreamloom Space`：`Dreamloom`（织梦）是产品做的事——把一段段零散的文字织成一整块布；
`Space` 是产品的骨架——所有内容都挂在「故事空间」这个容器上，人物库跨空间共用、每个空间各演各的。
两个词合起来正好是「一个能装下很多个梦的地方」，也保留了搜索辨识度（`dreamloom` 是独有词）。
不建议 `DreamloomStory`：连读时 `mST` 三个辅音挤在一起，念不出来。

## 九、作品介绍（用于作品页，约 120 字）

一个能长期写下去的 AI 互动小说工作台。适合喜欢阅读、也想自己动手写故事的人：
给一句话起点，它一段段往下写，每幕给你四个有区别的选择，故事会记住谁死过、东西放在哪、哪些问题还没答。
适合通勤、睡前、写作卡壳时用；也可以当作长篇创作的草稿机。
打开网页即用，无需注册；所有内容只存在你本机浏览器，可导出存档换设备继续。

## 十、English Description (~100 words)

Dreamloom Space is a writing desk for AI-assisted interactive fiction that stays coherent over
dozens of scenes. You give it one sentence; it writes forward scene by scene, offering four
distinct choices each turn — ask, act, observe, or leave — and it remembers what happened:
who died, where the letter was hidden, which questions are still unanswered. A structured canon
plus deterministic guardrails keep the model from contradicting itself, and every roll of the
dice is made in code, not by the model. Everything lives in your browser; export a JSON save to
continue elsewhere. No account, no cloud sync, your own API key.

## 十一、本轮新增（2026-10-29）

| 能力 | 说明 |
|---|---|
| 生图 | 封面、人物立绘、地点场景、单幕配图；提示词从档案拼出，同提示词不重复扣费 |
| 朗读 | 单幕朗读，音色可改；音频与图都存在本地并随存档导出 |
| 文本与图分开配 | 文本用 DeepSeek、图与声音用百炼，地址与 Key 各自一对 |
| 测试连接 | 设置页一次点击验证地址/模型/Key，直接显示模型名与往返毫秒 |
| 移动端 | 动作栏高度自适应、侧栏下移单列、输入框 16px 防缩放、触控 40px 起 |
| 隐私 | 书架与设置页明说「只存本机、不云同步」，并说明哪些数据会发给模型 |
| 人物库 | 侧栏那几行文字换成卡片式选择器：可看详情再决定导入 |
