/**
 * 存档信封：导出时为「一个空间 = 一个 JSON」，导入时校验并迁移。
 * 运行时是分行存储（见 store/），只有这里做合成与拆分。
 */

import { DomainError, ERR } from './errors'
import type {
  CanonSnapshot,
  CastMember,
  Fact,
  PatchRecord,
  Place,
  Relation,
  Scene,
  SpaceBundle,
  SpaceMeta,
  World,
} from './types'

export function buildBundle(input: {
  space: SpaceMeta
  world: World
  cast: CastMember[]
  places: Place[]
  relations: Relation[]
  facts: Fact[]
  scenes: Scene[]
  texts: Record<string, string>
  patches: PatchRecord[]
  snapshots: CanonSnapshot[]
  now: number
}): SpaceBundle {
  return {
    format: 'dreamloom',
    v: 1,
    exportedAt: input.now,
    space: input.space,
    world: input.world,
    cast: input.cast,
    places: input.places,
    relations: input.relations,
    facts: input.facts,
    scenes: [...input.scenes].sort((a, b) => a.index - b.index),
    texts: input.texts,
    patches: input.patches,
    snapshots: input.snapshots,
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

export function parseBundle(text: string): SpaceBundle {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new DomainError(ERR.BAD_REQUEST, '这不是一个合法的存档文件（JSON 解析失败）')
  }
  if (!isRecord(data)) {
    throw new DomainError(ERR.BAD_REQUEST, '存档内容不是一个对象')
  }
  if (data.format !== 'dreamloom') {
    throw new DomainError(ERR.BAD_REQUEST, '这不是筑梦者的存档文件')
  }
  if (!isRecord(data.space)) {
    throw new DomainError(ERR.BAD_REQUEST, '存档缺少空间信息')
  }
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

  const space = data.space as unknown as SpaceMeta
  const bundle: SpaceBundle = {
    format: 'dreamloom',
    v: 1,
    exportedAt: Number(data.exportedAt) || Date.now(),
    space: {
      ...space,
      hardRules: arr(space.hardRules) as string[],
      settings: {
        charPreset: space.settings?.charPreset ?? 'short',
        temperature: Number(space.settings?.temperature) || 0.9,
        choiceCount: Number(space.settings?.choiceCount) || 4,
        recentSummaries: Number(space.settings?.recentSummaries) || 8,
        economy: space.settings?.economy,
      },
      stats: space.stats ?? { calls: 0, inTok: 0, outTok: 0, chars: 0 },
      canonRev: Number(space.canonRev) || 0,
      sceneCount: Number(space.sceneCount) || arr(data.scenes).length,
      archiveWatermark: space.archiveWatermark ?? null,
      activeSceneId: space.activeSceneId ?? null,
    },
    world: (data.world as World) ?? {
      name: '未命名世界',
      era: '',
      theme: '',
      premise: '',
      oneLine: '',
      rules: [],
      factions: [],
      updatedAt: 0,
    },
    cast: arr(data.cast) as CastMember[],
    places: arr(data.places) as Place[],
    relations: arr(data.relations) as Relation[],
    facts: arr(data.facts) as Fact[],
    scenes: (arr(data.scenes) as Scene[]).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
    texts: isRecord(data.texts) ? (data.texts as Record<string, string>) : {},
    patches: arr(data.patches) as PatchRecord[],
    snapshots: arr(data.snapshots) as CanonSnapshot[],
  }
  return migrate(bundle)
}

/** 版本迁移：幂等，未知字段原样保留（向前兼容）。 */
export function migrate(bundle: SpaceBundle): SpaceBundle {
  if (bundle.v === 1) {
    // v1 基线：补齐可能缺失的字段
    bundle.cast = bundle.cast.map((c) => ({
      ...c,
      aliases: c.aliases ?? [],
      traits: c.traits ?? [],
      secrets: c.secrets ?? [],
      abilities: c.abilities ?? [],
      hobbies: c.hobbies ?? [],
      // 旧的 secrets 是纯文本数组：迁成带揭露幕的结构，默认都没揭开
      hidden: c.hidden ?? (c.secrets ?? []).map((text) => ({ text, revealedAt: null })),
      arc: c.arc ?? [],
      interactions: c.interactions ?? [],
      personaId: c.personaId ?? null,
      personaRev: c.personaRev ?? null,
      locked: c.locked ?? {},
      removedAt: c.removedAt ?? null,
      supersededBy: c.supersededBy ?? null,
      confidence: c.confidence ?? 0.6,
      origin: c.origin ?? 'extract',
    }))
    bundle.places = bundle.places.map((p) => ({
      ...p,
      features: p.features ?? [],
      inventory: p.inventory ?? [],
      events: p.events ?? [],
      exits: p.exits ?? [],
      parentId: p.parentId ?? null,
      interactions: p.interactions ?? [],
      coords: p.coords ?? null,
      locked: p.locked ?? {},
      removedAt: p.removedAt ?? null,
      supersededBy: p.supersededBy ?? null,
    }))
    bundle.scenes = bundle.scenes.map((s) => ({
      ...s,
      clues: (s.clues ?? []).map((c) => ({
        ...c,
        // 旧的 fact / promise 线索归一到 open-thread：类型收紧后它们不再合法
        kind: c.kind === 'loss' ? ('loss' as const) : ('open-thread' as const),
        thread: c.thread ?? { kind: 'main' as const, id: null, label: '主线' },
      })),
      choices: s.choices ?? [],
      participants: s.participants ?? [],
    }))
    bundle.snapshots = bundle.snapshots.map((snap) => ({
      ...snap,
      sceneIndex: typeof snap.sceneIndex === 'number' ? snap.sceneIndex : -1,
    }))
    bundle.facts = bundle.facts.map((f) => ({
      ...f,
      status: f.status ?? 'active',
      updatedAt: f.updatedAt ?? 0,
    }))
    bundle.space.mainGoal = bundle.space.mainGoal ?? ''
    // 旧存档没有目标系统：用 mainGoal 补一条主线目标，否则阶段会永远停在开场
    bundle.space.objectives = bundle.space.objectives ?? (bundle.space.mainGoal
      ? [
          {
            id: 'ob_legacy',
            text: bundle.space.mainGoal.slice(0, 60),
            kind: 'main' as const,
            status: 'active' as const,
            atSceneId: null,
            origin: 'user' as const,
          },
        ]
      : [])
    bundle.space.endedAt = bundle.space.endedAt ?? null
    // 旧存档默认按"有终点"处理：那是加入模式前唯一的行为
    bundle.space.mode = bundle.space.mode ?? 'goal'
    bundle.space.scheduled = bundle.space.scheduled ?? []
    bundle.world = { ...bundle.world, theme: bundle.world?.theme ?? '' }
  }
  return bundle
}
