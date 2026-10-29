/**
 * 导出：把档案渲染成人能读的文档。
 *
 * 单一事实源：导出**只读** CanonState + Scene，不复制业务规则、不写回存档。
 * UI 的预览和下载文件走同一个函数，避免"预览挺好、导出的不对"。
 *
 * 三种产物：
 *  - 故事正文（给人读的稿子）
 *  - 创作档案（世界/人物/地点/关系/事实/伏笔，作者视角，含未揭示设定）
 *  - 整合稿（档案 + 大纲 + 正文，一份能直接拿去改的东西）
 */

import type { CastMember, Fact, Place, Relation, Scene, SpaceMeta, World } from './types'

export interface ExportScene {
  scene: Scene
  text: string
}

export interface ExportDataSet {
  space: SpaceMeta
  world: World
  cast: CastMember[]
  places: Place[]
  relations: Relation[]
  facts: Fact[]
  scenes: ExportScene[]
}

const ROLE_LABEL: Record<CastMember['role'], string> = {
  protagonist: '主角',
  antagonist: '对手',
  support: '配角',
  extra: '路人',
}

const STATUS_LABEL: Record<CastMember['status'], string> = {
  alive: '在场',
  dead: '已死亡',
  missing: '失踪',
  unknown: '去向不明',
}

const REL_LABEL: Record<Relation['kind'], string> = {
  kin: '亲缘',
  ally: '同盟',
  rival: '竞争',
  enemy: '敌对',
  mentor: '师承',
  lover: '情感',
  employ: '雇佣',
  other: '其他',
}

const FACT_LABEL: Record<Fact['kind'], string> = {
  object: '物件',
  state: '状态',
  number: '数目',
  promise: '承诺',
  place: '地点',
  other: '其他',
}

const ARC_LABEL: Record<string, string> = {
  turn: '转折',
  loss: '失去',
  gain: '获得',
  reveal: '揭示',
  meeting: '相遇',
}

/** 只有 committed / orphan 才有正文；aborted 是半截，永不导出。 */
export function exportableScenes(scenes: ExportScene[]): ExportScene[] {
  return scenes
    .filter((s) => s.scene.status === 'committed' || s.scene.status === 'orphan')
    .sort((a, b) => a.scene.index - b.scene.index)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function sortCast(cast: CastMember[]): CastMember[] {
  const order: Record<CastMember['role'], number> = { protagonist: 0, antagonist: 1, support: 2, extra: 3 }
  return [...cast]
    .filter((c) => c.supersededBy === null)
    .sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name, 'zh'))
}

// ── 故事正文 ────────────────────────────────────────────

/** 关系强度：牵涉深度，不是感情好坏（那是 kind）。 */
export const STRENGTH_LABEL: Record<number, string> = {
  1: '点头之交',
  2: '有往来',
  3: '密切',
  4: '生死相关',
  5: '唯一牵挂',
}

const ACTION_LABEL: Record<string, string> = {
  option: '选择',
  random: '随机',
  free: '自述',
  continue: '续写',
}

export interface StoryTextOptions {
  /** 是否在每幕前带上玩家的行动（默认带：作者需要，读者可关掉） */
  withActions?: boolean
  /** 是否带「第 N 幕」小标题，默认带 */
  withHeadings?: boolean
  /** 是否在文末附上大纲，默认不带 */
  withOutline?: boolean
}

export function buildStoryText(ds: ExportDataSet, opts: StoryTextOptions = {}): string {
  const withHeadings = opts.withHeadings !== false
  const lines: string[] = [`# ${ds.space.title}`, '']
  if (ds.world.premise) lines.push(`> ${ds.world.premise}`, '')

  for (const { scene, text } of exportableScenes(ds.scenes)) {
    if (withHeadings) {
      const orphan = scene.status === 'orphan' ? '（未采用分支）' : ''
      lines.push(`## 第 ${scene.index + 1} 幕${orphan}`, '')
      // 回看时最想知道的是「当时为什么走到这一步」，所以把行动记在正文之前
      if (opts.withActions !== false && scene.action) {
        const kind = ACTION_LABEL[scene.action.kind] ?? '行动'
        lines.push(`> ${kind}：${scene.action.text}`, '')
      }
    }
    lines.push(text.trim() || '（这一幕没有正文）', '')
  }

  if (opts.withOutline) {
    lines.push('---', '', buildOutlineMarkdown(ds))
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

// ── 大纲 ────────────────────────────────────────────────

export function buildOutlineMarkdown(ds: ExportDataSet): string {
  const scenes = exportableScenes(ds.scenes)
  const lines: string[] = ['## 大纲', '']
  if (ds.space.mainGoal) lines.push(`**主线目标**：${ds.space.mainGoal}`, '')
  if (!scenes.length) {
    lines.push('（还没有推进过）')
    return lines.join('\n')
  }
  lines.push('| 幕 | 摘要 | 伏笔 |', '|---|---|---|')
  for (const { scene } of scenes) {
    const open = scene.clues.filter((c) => c.status === 'open').length
    const resolved = scene.clues.length - open
    const clueText = scene.clues.length
      ? `${open} 开 / ${resolved} 收`
      : '—'
    const summary = (scene.summary ?? '（无摘要）').replace(/\|/g, '｜')
    lines.push(`| ${scene.index + 1} | ${summary} | ${clueText} |`)
  }
  lines.push('')
  return lines.join('\n')
}

// ── 创作档案 ────────────────────────────────────────────

export interface CodexOptions {
  /** 是否包含 secrets（作者视角）。默认包含，但会显式标注。 */
  withSecrets?: boolean
}

export function buildCodexMarkdown(ds: ExportDataSet, opts: CodexOptions = {}): string {
  const withSecrets = opts.withSecrets !== false
  const lines: string[] = [`# ${ds.space.title} · 创作档案`, '']

  lines.push(
    `- 类型：${ds.space.genre}`,
    `- 基调：${ds.space.tone}`,
    `- 创建：${formatDate(ds.space.createdAt)}`,
    `- 已写：${exportableScenes(ds.scenes).length} 幕`,
    '',
  )

  // 世界
  lines.push('## 世界', '')
  lines.push(`- **名称**：${ds.world.name || '—'}`)
  lines.push(`- **时代**：${ds.world.era || '—'}`)
  if (ds.world.theme) lines.push(`- **主题**：${ds.world.theme}`)
  if (ds.world.premise) lines.push(`- **前提**：${ds.world.premise}`)
  if (ds.world.oneLine) lines.push(`- **一句话**：${ds.world.oneLine}`)
  if (ds.world.factions.length) lines.push(`- **势力**：${ds.world.factions.join('、')}`)
  const rules = [...ds.world.rules, ...ds.space.hardRules]
  if (rules.length) {
    lines.push('', '**铁律**')
    for (const rule of rules) lines.push(`- ${rule}`)
  }
  lines.push('')

  // 人物
  lines.push('## 人物', '')
  const cast = sortCast(ds.cast)
  if (!cast.length) lines.push('（还没有人物）', '')
  for (const c of cast) {
    const flags = [
      ROLE_LABEL[c.role],
      STATUS_LABEL[c.status],
      c.personaId ? '来自人物库' : '',
    ].filter(Boolean)
    lines.push(`### ${c.name}${c.aliases.length ? `（${c.aliases.join('、')}）` : ''}`, '')
    lines.push(`- ${flags.join(' · ')}`)
    if (c.oneLine) lines.push(`- 一句话：${c.oneLine}`)
    if (c.voice) lines.push(`- 语气：${c.voice}`)
    if (c.goal) lines.push(`- 目标：${c.goal}`)
    if (c.traits.length) lines.push(`- 特征：${c.traits.join('、')}`)
    if (c.interactions.length) lines.push(`- 可交互：${c.interactions.join('、')}`)
    if (withSecrets && c.secrets.length) {
      lines.push(`- 秘密（未揭示）：${c.secrets.join('；')}`)
    }
    if (c.arc.length) {
      lines.push('', '**故事线**')
      for (const beat of c.arc) {
        lines.push(`- 第 ${beatIndex(ds, beat.sceneId)} 幕 · ${ARC_LABEL[beat.kind] ?? beat.kind}：${beat.text}`)
      }
    }
    lines.push('')
  }

  // 地点
  lines.push('## 地点', '')
  const places = [...ds.places].filter((p) => p.supersededBy === null).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  if (!places.length) lines.push('（还没有地点）', '')
  for (const p of places) {
    lines.push(`### ${p.name}（${p.kind}）`, '')
    if (p.oneLine) lines.push(`- ${p.oneLine}`)
    if (p.features.length) lines.push(`- 特征：${p.features.join('、')}`)
    if (p.inventory.length) lines.push(`- 货架/陈设：${p.inventory.join('、')}`)
    if (p.interactions.length) lines.push(`- 可交互：${p.interactions.join('、')}`)
    if (p.events.length) {
      lines.push('', '**这里发生过**')
      for (const e of p.events) lines.push(`- 第 ${beatIndex(ds, e.sceneId)} 幕：${e.text}`)
    }
    lines.push('')
  }

  // 关系
  lines.push('## 关系', '')
  if (!ds.relations.length) lines.push('（还没有关系）', '')
  else {
    const nameOf = new Map(ds.cast.map((c) => [c.id, c.name]))
    lines.push('| A | B | 类型 | 强度 | 备注 |', '|---|---|---|---|---|')
    for (const r of [...ds.relations].sort((a, b) => a.edgeKey.localeCompare(b.edgeKey))) {
      const a = nameOf.get(r.aId) ?? '（已移除）'
      const b = nameOf.get(r.bId) ?? '（已移除）'
      lines.push(
        `| ${a} | ${b} | ${REL_LABEL[r.kind]} | ${STRENGTH_LABEL[r.strength] ?? r.strength} | ${r.note || '—'} |`,
      )
    }
  }
  lines.push('')

  // 事实
  lines.push('## 已知事实', '')
  const facts = ds.facts.filter((f) => f.status === 'active')
  if (!facts.length) lines.push('（还没有结构化事实）')
  else {
    for (const f of [...facts].sort((a, b) => a.updatedAt - b.updatedAt)) {
      lines.push(`- 【${FACT_LABEL[f.kind]}】${f.subject} ${f.predicate} ${f.object}`)
    }
  }
  lines.push('')

  // 伏笔
  lines.push('## 伏笔', '')
  const clues = exportableScenes(ds.scenes).flatMap((s) => s.scene.clues)
  if (!clues.length) lines.push('（还没有伏笔）')
  else {
    for (const c of clues) {
      const mark = c.status === 'open' ? '未收' : '已收'
      const known = c.known ? `已知：${c.known}；` : ''
      lines.push(`- [${mark}] ${known}待答：${c.unknown || c.text}（第 ${beatIndex(ds, c.sceneId)} 幕）`)
    }
  }
  lines.push('')

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function beatIndex(ds: ExportDataSet, sceneId: string): string {
  const found = ds.scenes.find((s) => s.scene.id === sceneId)
  return found ? String(found.scene.index + 1) : '?'
}

// ── 整合稿 ──────────────────────────────────────────────

/** 创作辅助的主产物：档案 + 大纲 + 正文，一份能直接拿去改的文档。 */
export function buildFullMarkdown(ds: ExportDataSet): string {
  const outline = buildOutlineMarkdown(ds)
  const codex = buildCodexMarkdown(ds)
  const story = buildStoryText(ds)
  return [
    codex.trimEnd(),
    '',
    '---',
    '',
    outline.trimEnd(),
    '',
    '---',
    '',
    '# 正文',
    '',
    story.replace(/^# .*\n+/, '').replace(/^> .*\n+/, '').trimStart(),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n'
}

export type ExportFormat = 'story' | 'outline' | 'codex' | 'full'

export function buildExport(ds: ExportDataSet, format: ExportFormat): string {
  switch (format) {
    case 'story':
      return buildStoryText(ds)
    case 'outline':
      return buildOutlineMarkdown(ds)
    case 'codex':
      return buildCodexMarkdown(ds)
    case 'full':
      return buildFullMarkdown(ds)
  }
}

/** 文件名：标题 + 产物类型，去掉路径分隔符等危险字符。 */
export function exportFileName(title: string, format: ExportFormat, ext = 'md'): string {
  const safe = (title || '未命名').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40)
  const suffix: Record<ExportFormat, string> = {
    story: '正文',
    outline: '大纲',
    codex: '档案',
    full: '全稿',
  }
  return `${safe}-${suffix[format]}.${ext}`
}
