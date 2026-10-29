/**
 * 一句话生成空间：把模型给的草稿校验成一个**一定能开写**的结构。
 *
 * 为什么校验这么啰嗦：模型给出的东西经常差一点就不能用——
 * 5 个主角、名字为空、地点只有 1 个。任何一条不处理，用户点"开始"就会撞墙。
 * 与其报错让人回去重填，不如尽量修好并说明改了什么。
 */

import type { CastRole } from '../domain/types'
import { parseLooseJson } from '../domain/jsonrepair'
import { DomainError, ERR } from '../domain/errors'
import type { SeedPort } from '../agents/ports'
import { createSpaceFromSeed } from './createSpace'
import type { SpaceRepo } from '../store/repo'
import type { SpaceMeta } from '../domain/types'

export interface SeedDraft {
  world: {
    name: string
    era: string
    theme: string
    premise: string
    oneLine: string
    rules: string[]
    factions: string[]
  }
  cast: Array<{
    name: string
    role: CastRole
    oneLine: string
    voice: string
    traits: string[]
    goal: string
  }>
  places: Array<{ name: string; kind: string; oneLine: string; features: string[] }>
  opening: string
  /** 建议的剧情节拍（第 N 幕必须发生） */
  events: Array<{ atSceneIndex: number; text: string }>
  /** 校验过程中做过的调整，展示给用户 */
  notes: string[]
}

const ROLES: CastRole[] = ['protagonist', 'antagonist', 'support', 'extra']

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function list(value: unknown, max: number, itemMax: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => str(v, itemMax))
    .filter(Boolean)
    .slice(0, max)
}

/** 把任意模型输出纠正成可用的草稿。不可修复时抛 `E_PARSE_FAILED`。 */
export function validateSeed(raw: unknown): SeedDraft {
  const notes: string[] = []
  const data = (raw ?? {}) as Record<string, unknown>
  const worldRaw = (data.world ?? {}) as Record<string, unknown>

  const worldName = str(worldRaw.name, 20) || '未命名世界'
  const world = {
    name: worldName,
    era: str(worldRaw.era, 24),
    theme: str(worldRaw.theme, 60),
    premise: str(worldRaw.premise, 80),
    oneLine: str(worldRaw.oneLine, 40) || str(worldRaw.premise, 80),
    rules: list(worldRaw.rules, 3, 40),
    factions: list(worldRaw.factions, 4, 16),
  }

  // ── 人物：必须有名字，必须有且只有一个主角
  const castRaw = Array.isArray(data.cast) ? data.cast : []
  let cast = castRaw
    .map((c) => {
      const item = (c ?? {}) as Record<string, unknown>
      return {
        name: str(item.name, 12),
        role: (ROLES.includes(item.role as CastRole) ? item.role : 'support') as CastRole,
        oneLine: str(item.oneLine, 40),
        voice: str(item.voice, 30),
        traits: list(item.traits, 6, 8),
        goal: str(item.goal, 80),
      }
    })
    .filter((c) => c.name)

  if (!cast.length) {
    throw new DomainError(ERR.PARSE_FAILED, '生成的人物里没有可用名字，换一句描述再试')
  }
  if (cast.length > 5) {
    cast = cast.slice(0, 5)
    notes.push('人物超过 5 个，已保留前 5 个')
  }

  const protagonists = cast.filter((c) => c.role === 'protagonist')
  if (protagonists.length === 0) {
    cast = cast.map((c, i) => (i === 0 ? { ...c, role: 'protagonist' as CastRole } : c))
    notes.push('没有指定主角，已把第一个人设为主角')
  } else if (protagonists.length > 1) {
    let kept = false
    cast = cast.map((c) => {
      if (c.role !== 'protagonist') return c
      if (!kept) {
        kept = true
        return c
      }
      return { ...c, role: 'support' as CastRole }
    })
    notes.push(`有 ${protagonists.length} 个主角，只保留第一个`)
  }

  // ── 地点：至少要有两个，否则玩家无处可去
  const placesRaw = Array.isArray(data.places) ? data.places : []
  let places = placesRaw
    .map((p) => {
      const item = (p ?? {}) as Record<string, unknown>
      return {
        name: str(item.name, 12),
        kind: str(item.kind, 12) || '场所',
        oneLine: str(item.oneLine, 40),
        features: list(item.features, 6, 10),
      }
    })
    .filter((p) => p.name)

  if (places.length > 4) {
    places = places.slice(0, 4)
    notes.push('地点超过 4 个，已保留前 4 个')
  }
  if (places.length < 2) {
    places = [...places, { name: '附近的街道', kind: '街道', oneLine: '', features: [] }]
    notes.push('地点太少，已补一条「附近的街道」')
  }

  // 剧情节拍：模型给的建议节点，最多 3 个，幕序去重
  const eventsRaw = Array.isArray(data.events) ? data.events : []
  const seenAt = new Set<number>()
  const events: Array<{ atSceneIndex: number; text: string }> = []
  for (const item of eventsRaw) {
    const e = (item ?? {}) as Record<string, unknown>
    const at = Number(e.at)
    const text = str(e.text, 80)
    if (!text || !Number.isFinite(at) || at < 0 || seenAt.has(at)) continue
    seenAt.add(at)
    events.push({ atSceneIndex: Math.round(at), text })
    if (events.length >= 3) break
  }

  return {
    world,
    cast,
    places,
    opening: str(data.opening, 120),
    events,
    notes,
  }
}

/** 解析模型返回的文本（宽容 JSON）并校验。 */
export function parseSeedText(text: string): SeedDraft {
  let parsed: unknown
  try {
    parsed = parseLooseJson(text)
  } catch {
    throw new DomainError(ERR.PARSE_FAILED, '生成结果没能解析成设定，换一句描述再试')
  }
  return validateSeed(parsed)
}

/** 生成 → 校验 → 建空间。失败时抛可读错误，由 UI 提示。 */
export async function generateSpace(
  deps: { repo: SpaceRepo; seeder: SeedPort; now: () => number },
  input: { oneLine: string; genre?: string; tone?: string; title?: string },
): Promise<{ meta: SpaceMeta; draft: SeedDraft }> {
  const oneLine = input.oneLine.trim()
  if (!oneLine) throw new DomainError(ERR.BAD_REQUEST, '用一句话说说你想写什么')

  const res = await deps.seeder.generate({
    runId: `sd_${deps.now()}`,
    oneLine,
    genre: input.genre,
    tone: input.tone,
  })

  const draft = parseSeedText(res.text)

  const meta = await createSpaceFromSeed({
    repo: deps.repo,
    title: input.title?.trim() || draft.world.name,
    cover: '🌫️',
    genre: input.genre ?? '自定义',
    tone: input.tone ?? '克制',
    world: { ...draft.world, updatedAt: 0 },
    cast: draft.cast.map((c) => ({
      name: c.name,
      role: c.role,
      oneLine: c.oneLine,
      voice: c.voice,
      traits: c.traits,
      secrets: [],
    })),
    places: draft.places.map((p) => ({
      name: p.name,
      kind: p.kind,
      oneLine: p.oneLine,
      features: p.features,
    })),
    mainGoal: draft.cast.find((c) => c.role === 'protagonist')?.goal ?? '',
    hardRules: draft.world.rules,
  })

  // 把建议的节拍写进空间（建完后仍可在档案页改）
  if (draft.events.length) {
    const latest = await deps.repo.loadMeta(meta.id)
    await deps.repo.saveMeta(meta.id, {
      ...latest,
      scheduled: draft.events.map((e, i) => ({
        id: `ev_seed_${i}`,
        atSceneIndex: e.atSceneIndex,
        text: e.text,
        fired: false,
        origin: 'extract' as const,
      })),
    })
  }

  return { meta, draft }
}
