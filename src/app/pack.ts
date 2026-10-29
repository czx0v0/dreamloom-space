/**
 * 上下文装配：把档案例子渲染成叙事 Agent 要的分区字符串。
 *
 * 这里是「注意力预算」真正生效的地方：渲染得越啰嗦，能塞进去的有用信息越少。
 * 所以每个分区都刻意压缩成表/短句，不写小作文。
 */

import { packSections, type BudgetConfig } from '../domain/budget'
import { keywordCandidates, recall as rank } from '../domain/recall'
import type { CanonState, CastMember, Scene, SpaceMeta } from '../domain/types'
import type { NarrateSections } from '../agents/contracts'
import { PHASE_LABEL, PHASE_RULE, objectiveProgress, resolvePhase } from '../domain/objective'
import { placePath } from '../domain/place'
import type { ClientConfig } from './config'

export interface PackInput {
  meta: SpaceMeta
  canon: CanonState
  /** 已提交的场景，按 index 升序 */
  scenes: Scene[]
  /** 每幕正文，仅在需要做关键词召回时提供 */
  texts?: Record<string, string>
  action: string
}

export interface PackResult {
  sections: NarrateSections
  dropped: string[]
  usedChars: number
}

const STATUS_MARK: Record<CastMember['status'], string> = {
  alive: '',
  dead: '[已死亡]',
  missing: '[失踪]',
  unknown: '[去向不明]',
}

function worldSection(canon: CanonState): string {
  const w = canon.world
  return [w.name, w.era, w.theme].filter(Boolean).join('｜') +
    (w.premise ? `\n${w.premise}` : '') +
    (w.oneLine ? `\n${w.oneLine}` : '') +
    (w.factions.length ? `\n势力：${w.factions.join('、')}` : '')
}

function rulesSection(meta: SpaceMeta, canon: CanonState): string {
  const rules = [...canon.world.rules, ...meta.hardRules].filter(Boolean)
  return rules.map((r) => `- ${r}`).join('\n')
}

/**
 * 剧情位置：主线目标 + 目标进度 + 阶段 + 本阶段要求。
 *
 * 「进度」是这一块存在的理由：只写目标时，模型会一直揭示新细节而不靠近答案。
 * 把「3/7 达成」与「已经接近结局」摆出来，它才知道该加速。
 */
export function outlineSection(meta: SpaceMeta, scenes: Scene[]): string {
  const last = scenes[scenes.length - 1]
  const phase = resolvePhase(meta, scenes.length)
  // 本幕（= 即将生成的那一幕）到期的固定事件
  const due = meta.scheduled.filter((e) => !e.fired && e.atSceneIndex === scenes.length)
  const progress = objectiveProgress(meta)
  const lines: string[] = []

  if (meta.mainGoal) lines.push(`主线目标：${meta.mainGoal}`)

  const active = meta.objectives.filter((o) => o.status === 'active').slice(0, 5)
  if (active.length) {
    lines.push(`待完成（${progress.done}/${progress.total}）：`)
    for (const o of active) lines.push(`- ${o.kind === 'main' ? '【主线】' : ''}${o.text}`)
  } else if (meta.objectives.length) {
    lines.push(`目标已全部达成（${progress.done}/${progress.total}）。`)
  }

  lines.push(`当前阶段：${PHASE_LABEL[phase]}`)
  const rule = PHASE_RULE[phase]
  if (rule) lines.push(rule)

  // 固定事件是硬节拍：写成「必须发生」，不给模型"可以跳过"的余地
  if (due.length) {
    lines.push('【本幕必须发生】')
    for (const e of due) lines.push(`- ${e.text}`)
  }

  if (last?.summary) lines.push(`刚写完：第 ${last.index + 1} 幕 · ${last.summary}`)
  else lines.push('这是开篇，需要建立场景与人物关系。')

  return lines.join('\n')
}

function presentCast(canon: CanonState, scenes: Scene[]): CastMember[] {
  const active = canon.cast.filter((c) => c.removedAt === null && c.supersededBy === null)
  const last = scenes[scenes.length - 1]
  const present = last?.participants?.length
    ? active.filter((c) => last.participants.includes(c.id))
    : []
  const pool = present.length ? present : active
  const rank = (c: CastMember) => (c.role === 'protagonist' ? 0 : c.status === 'dead' ? 2 : 1)
  return [...pool].sort((a, b) => rank(a) - rank(b))
}

/**
 * 角色的「想要」以及谁挡着他。
 *
 * 只写 personality 会让人物变成标签，故事就成了流水账：
 * 每一幕都要有人想做点什么、并且撞上阻力，才有推进。
 * 阻力直接从关系表推（rival / enemy），不需要模型额外输出。
 */
function goalCell(member: CastMember, canon: CanonState): string {
  if (!member.goal) return '—'
  const blockers = canon.relations
    .filter(
      (r) =>
        (r.aId === member.id || r.bId === member.id) &&
        (r.kind === 'enemy' || r.kind === 'rival'),
    )
    .map((r) => canon.cast.find((c) => c.id === (r.aId === member.id ? r.bId : r.aId))?.name)
    .filter((name): name is string => Boolean(name))
  const unique = [...new Set(blockers)]
  return unique.length ? `${member.goal}（与 ${unique.join('、')} 相争）` : member.goal
}

function castSection(canon: CanonState, scenes: Scene[], limit: number): string {
  const cast = presentCast(canon, scenes).slice(0, limit)
  if (!cast.length) return ''
  const rows = cast.map((c) => {
    const mark = STATUS_MARK[c.status]
    const name = mark ? `${c.name}${mark}` : c.name
    // 本事 = 会什么 + 喜欢什么：这是"他能做什么"，和"他想要什么"是两回事
    const skill = [...c.abilities, ...c.hobbies].slice(0, 4).join('、') || '—'
    return `| ${name} | ${c.oneLine || '—'} | ${c.voice || '—'} | ${goalCell(c, canon)} | ${skill} |`
  })
  const table = ['| 名字 | 一句话 | 语气 | 想要 | 本事 |', '|---|---|---|---|---|', ...rows]

  // 已揭开的秘密：只带 revealedAt 有值的，没揭开的绝不进叙事 prompt
  const revealed = cast.flatMap((c) =>
    c.hidden
      .filter((h) => h.revealedAt !== null)
      .map((h) => `- ${c.name}：${h.text}`),
  )
  if (revealed.length) {
    table.push('', '已经揭开的：', ...revealed.slice(0, 6))
  }

  return table.join('\n')
}

/**
 * 地点分区：**「你在哪」而不是「世界上有哪些地方」**。
 *
 * 平铺一份地点列表时，模型看不出玩家此刻站在哪，于是玩家选了「去三号仓库」，
 * 下一段它还能接着写客栈。位置是上下文里最便宜、收益最大的一条信息。
 */
export function placesSection(canon: CanonState, scenes: Scene[], limit: number): string {
  const all = canon.places.filter((p) => p.removedAt === null && p.supersededBy === null)
  const currentId = scenes.length ? scenes[scenes.length - 1].placeId : null
  const current = currentId ? all.find((p) => p.id === currentId) : undefined

  const parts: string[] = []
  if (current) {
    const detail = [current.kind, current.oneLine].filter(Boolean).join('·')
    // 带父级路径：「三号仓库 / 侧门小屋」比单说「侧门小屋」明确得多
    const path = placePath(all, current.id)
    parts.push(`【你现在在哪】${path}${detail ? `（${detail}）` : ''}`)
    if (current.features.length) {
      parts.push(`环境：${current.features.slice(0, 4).join('、')}`)
    }
    const exits = current.exits
      .map((id) => all.find((p) => p.id === id)?.name)
      .filter((name): name is string => Boolean(name))
    if (exits.length) parts.push(`【能去哪】${exits.join('、')}`)
  }

  const others = all.filter((p) => p.id !== currentId).slice(0, limit)
  if (others.length) {
    parts.push(`【其他已知地点】${others.map((p) => p.name).join('、')}`)
  }
  return parts.join('\n')
}

function relationsSection(canon: CanonState, limit: number): string {
  const nameOf = new Map(canon.cast.map((c) => [c.id, c.name]))
  return canon.relations
    .slice(0, limit)
    .map((r) => `- ${nameOf.get(r.aId) ?? '?'} — ${nameOf.get(r.bId) ?? '?'}：${r.kind}（${r.strength}/5）`)
    .join('\n')
}

/**
 * 未收伏笔。
 *
 * 三个决定：
 *  1. **按线索分组**——「这条服务于谁」是模型决定要不要收的唯一依据。
 *     平铺一串文本时，每条看起来都同样可有可无，结果就是只开不收。
 *  2. **标出埋下的幕号与悬置时长**，超过阈值直接写「该收了」。
 *  3. **积压到一定数量就下硬要求**：不写进去，模型永远优先开新坑。
 */
export function cluesSection(
  scenes: Scene[],
  limit: number,
  staleAfter = 8,
  pressureAt = 6,
  maxOpen = 12,
): string {
  if (!scenes.length) return ''
  const latestIndex = scenes[scenes.length - 1].index
  const open = scenes
    .flatMap((scene) => scene.clues.map((clue) => ({ clue, at: scene.index })))
    .filter(({ clue }) => clue.status === 'open')
    .slice(-limit)

  if (!open.length) return ''

  const groups = new Map<string, string[]>()
  let staleCount = 0
  for (const { clue, at } of open) {
    const label = clue.thread?.label || '主线'
    const age = Math.max(0, latestIndex - at)
    const stale = age >= staleAfter
    if (stale) staleCount++
    const tag = stale ? `，已悬 ${age} 幕，该收了` : `，已悬 ${age} 幕`
    // 只把"还没答的问题"给模型看；已知部分压到 16 字，够它判断"为什么值得追"即可
    const known = (clue.known ?? '').slice(0, 16)
    const line = known
      ? `- ${clue.unknown || clue.text}（已知：${known}…；第 ${at + 1} 幕埋下${tag}）`
      : `- ${clue.unknown || clue.text}（第 ${at + 1} 幕埋下${tag}）`
    const bucket = groups.get(label)
    if (bucket) bucket.push(line)
    else groups.set(label, [line])
  }

  const body = [...groups.entries()].map(([label, lines]) => `${label}：\n${lines.join('\n')}`)

  // 积压提示：没有这句，模型会一直开新坑
  if (open.length >= maxOpen) {
    body.push(
      `【本幕要求】未收线索已达上限（${open.length}/${maxOpen}）。本幕**不能**再开新线索，` +
        '必须先在正文里解答其中一条，并输出 resolve-clue。',
    )
  } else if (staleCount > 0) {
    body.push(
      `【本幕要求】已有 ${staleCount} 条线索悬置超过 ${staleAfter} 幕，本幕必须收掉其中至少一条：` +
        '在正文里给出明确答案，而不是"又接近了一点"。',
      '四个选项里至少有一个要直奔其中一条的答案。',
    )
  } else if (open.length >= pressureAt) {
    body.push(
      `【本幕要求】未收线索已累积 ${open.length} 条。本幕必须先收掉一条旧线索：` +
        '指认清楚、给个答案，读者读完要知道"这条结了"。',
      '四个选项里至少有一个是去解开其中一条，而不是再开新问题。',
    )
  }

  return body.join('\n\n')
}

function factsSection(canon: CanonState, limit: number): string {
  const facts = canon.facts
    .filter((f) => f.status === 'active')
    .slice(-limit)
  return facts.map((f) => `- ${f.subject} ${f.predicate} ${f.object}`).join('\n')
}

function arcsSection(canon: CanonState, scenes: Scene[], perCast: number): string {
  const lines: string[] = []
  for (const c of presentCast(canon, scenes)) {
    const beats = c.arc.slice(-perCast)
    if (!beats.length) continue
    lines.push(`- ${c.name}：${beats.map((b) => b.text).join('；')}`)
  }
  return lines.join('\n')
}

export function placeEventsSection(canon: CanonState, scenes: Scene[], limit: number): string {
  // 原来用 last.participants.includes(p.id) 找地点 —— participants 是人物 id，
  // 永远匹配不到，地点旧事几乎从来没被正确带进上下文。改用 placeId。
  const currentId = scenes.length ? scenes[scenes.length - 1].placeId : null
  const place =
    (currentId ? canon.places.find((p) => p.id === currentId) : null) ??
    canon.places.find((p) => p.events.length > 0)
  if (!place?.events.length) return ''
  const events = place.events.slice(-limit)
  return [`${place.name}：`, ...events.map((e) => `- ${e.text}`)].join('\n')
}

function summariesSection(scenes: Scene[], limit: number): string {
  return scenes
    .filter((s) => s.summary)
    .slice(-limit)
    .map((s) => `- 第 ${s.index + 1} 幕：${s.summary}`)
    .join('\n')
}

function tailOf(text: string | undefined, limit: number): string {
  const clean = (text ?? '').trim()
  if (!clean) return ''
  return clean.length > limit ? `…${clean.slice(-limit)}` : clean
}

/** 无向量时的关键词召回：只用摘要做索引，零额外 IO。 */
function recallSection(input: PackInput, cfg: ClientConfig, budget: number): string {
  if (!cfg.recall.enabled || input.scenes.length <= 3) return ''
  const docs = input.scenes
    .filter((s) => s.summary)
    .map((s) => ({
      sceneId: s.id,
      index: s.index,
      text: `${s.summary} ${input.texts?.[s.id] ?? ''}`.trim(),
      castIds: s.participants,
    }))
  const candidates = keywordCandidates(input.action, docs)
  const picked = rank(candidates, {
    weights: { cosine: 0.7, recency: 0.2, entity: 0.1 },
    minScore: cfg.recall.minScore,
    topK: cfg.recall.topK,
    keep: cfg.recall.keep,
    currentIndex: input.scenes.length,
    excludeSceneIds: input.scenes.slice(-cfg.budget.recentSummaries).map((s) => s.id),
    entityIds: [],
    budgetChars: budget,
  })
  return picked.map((r) => `- 第 ${r.index + 1} 幕：${r.text.slice(0, 120)}`).join('\n')
}

export function buildPack(input: PackInput, cfg: ClientConfig): PackResult {
  const { meta, canon, scenes } = input
  const isFree = meta.mode === 'free'
  const lastScene = scenes[scenes.length - 1]
  const lastTailLimit = cfg.budget.sections.lastTail ?? 600

  const raw: Record<string, string> = {
    world: worldSection(canon),
    rules: rulesSection(meta, canon),
    outline: outlineSection(meta, scenes),
    cast: castSection(canon, scenes, cfg.budget.maxCast),
    places: placesSection(canon, scenes, cfg.budget.maxPlaces),
    relations: relationsSection(canon, cfg.budget.maxRelations),
    // 自由模式不催收线索：仍受数量上限约束，但不写"必须收一条"这类要求
    clues: cluesSection(
      scenes,
      cfg.budget.maxClues,
      isFree ? Number.POSITIVE_INFINITY : 12,
      isFree ? Number.POSITIVE_INFINITY : 6,
      isFree ? Number.POSITIVE_INFINITY : cfg.budget.maxOpenClues,
    ),
    facts: factsSection(canon, cfg.budget.promptFacts),
    arcs: arcsSection(canon, scenes, 2),
    placeEvents: placeEventsSection(canon, scenes, 3),
    summaries: summariesSection(scenes, cfg.budget.recentSummaries),
    recall: recallSection(input, cfg, cfg.budget.sections.recall ?? 250),
    lastTail: tailOf(input.texts?.[lastScene?.id ?? ''], lastTailLimit),
    action: input.action,
  }

  const budgetCfg: BudgetConfig = {
    contentBudget: cfg.budget.contentBudget,
    sections: cfg.budget.sections,
    trimOrder: cfg.budget.trimOrder,
    pinned: cfg.budget.pinned,
  }
  const packed = packSections(raw, budgetCfg)

  return {
    sections: packed.sections as NarrateSections,
    dropped: packed.dropped,
    usedChars: packed.usedChars,
  }
}
