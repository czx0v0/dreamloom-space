/**
 * 仓储：把空间拆成行存到 KV。
 *
 * 为什么不做「一个空间 = 一个 JSON」：
 * 第 40 幕时单文档约 150KB，每次抽取 patch 都要全量克隆 + 全量写（20–60ms 卡顿）；
 * 书架列表被迫加载全部正文；回退也还原不出「那一刻的档案」。
 * 导出时才合成一个 JSON（见 domain/archive.ts）。
 */

import { buildBundle, migrate } from '../domain/archive'
import type { ExportDataSet } from '../domain/export'
import { makeId } from '../domain/ids'
import type {
  Art,
  ArtKind,
  CanonSnapshot,
  CanonState,
  CastMember,
  CharPreset,
  Pov,
  SpaceMode,
  Fact,
  MergeProposal,
  PatchRecord,
  Persona,
  PersonaIndexEntry,
  Place,
  Relation,
  Scene,
  SpaceBundle,
  SpaceIndexEntry,
  SpaceMeta,
  World,
} from '../domain/types'
import { K, P, revFromKey } from './keys'
import type { KvPort } from './kv'

export interface RepoDeps {
  kv: KvPort
  now: () => number
  rand?: () => number
}

/** 建空间时的生成默认值（来自全局设置）。 */
export interface CreateDefaults {
  temperature?: number
  choiceCount?: number
}

export interface CreateSpaceInput {
  title: string
  cover?: string
  genre?: string
  tone?: string
  mainGoal?: string
  hardRules?: string[]
  preset?: CharPreset
  pov?: Pov
  mode?: SpaceMode
  defaults?: CreateDefaults
  world: Pick<World, 'name' | 'era' | 'theme' | 'premise' | 'oneLine' | 'rules' | 'factions'>
  cast: Array<Partial<CastMember> & { name: string }>
  places: Array<Partial<Place> & { name: string }>
}

const emptyWorld = (): World => ({
  name: '',
  era: '',
  theme: '',
  premise: '',
  oneLine: '',
  rules: [],
  factions: [],
  updatedAt: 0,
})

/**
 * 旧存档的字段补齐。幂等，并且**不写回库**：
 * 每次读都补一次比每次读都触发一次写安全（后者会在回退与多标签之间打架）。
 */
export function normalizeMeta(raw: SpaceMeta): SpaceMeta {
  const stats = {
    calls: raw.stats?.calls ?? 0,
    inTok: raw.stats?.inTok ?? 0,
    outTok: raw.stats?.outTok ?? 0,
    chars: raw.stats?.chars ?? 0,
  }
  return {
    ...raw,
    v: 1,
    mode: raw.mode ?? 'goal',
    hardRules: raw.hardRules ?? [],
    mainGoal: raw.mainGoal ?? '',
    objectives: raw.objectives ?? [],
    scheduled: raw.scheduled ?? [],
    pov: raw.pov ?? 'third',
    protagId: raw.protagId ?? null,
    endedAt: raw.endedAt ?? null,
    activeSceneId: raw.activeSceneId ?? null,
    archiveWatermark: raw.archiveWatermark ?? null,
    sceneCount: raw.sceneCount ?? 0,
    canonRev: raw.canonRev ?? 0,
    settings: {
      charPreset: raw.settings?.charPreset ?? 'short',
      temperature: raw.settings?.temperature ?? 0.9,
      choiceCount: raw.settings?.choiceCount ?? 4,
      recentSummaries: raw.settings?.recentSummaries ?? 8,
    },
    stats,
  }
}

export function normalizePersona(p: Persona): Persona {
  return {
    ...p,
    aliases: p.aliases ?? [],
    personality: p.personality ?? [],
    abilities: p.abilities ?? [],
    secrets: p.secrets ?? [],
    tags: p.tags ?? [],
    appearance: p.appearance ?? '',
    backstory: p.backstory ?? '',
    voice: p.voice ?? '',
    oneLine: p.oneLine ?? '',
    rev: p.rev ?? 1,
    origin: p.origin ?? 'user',
  }
}

export function normalizeCast(c: CastMember): CastMember {
  return {
    ...c,
    aliases: c.aliases ?? [],
    traits: c.traits ?? [],
    secrets: c.secrets ?? [],
    abilities: c.abilities ?? [],
    hobbies: c.hobbies ?? [],
    hidden: c.hidden ?? (c.secrets ?? []).map((text) => ({ text, revealedAt: null })),
    arc: c.arc ?? [],
    interactions: c.interactions ?? [],
    locked: c.locked ?? {},
    personaId: c.personaId ?? null,
    personaRev: c.personaRev ?? null,
    removedAt: c.removedAt ?? null,
    supersededBy: c.supersededBy ?? null,
    confidence: c.confidence ?? 0.6,
    origin: c.origin ?? 'extract',
    voiceId: c.voiceId ?? '',
    gender: c.gender ?? 'unknown',
  }
}

export function normalizePlace(p: Place): Place {
  return {
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
  }
}

export function createRepo(deps: RepoDeps) {
  const { kv, now } = deps
  const rand = deps.rand ?? Math.random
  const idGen = (prefix: string) => makeId(prefix, now(), rand)

  async function writeAll(pairs: Array<[string, unknown]>) {
    await Promise.all(pairs.map(([key, value]) => kv.set(key, value)))
  }

  async function getAll<T>(prefix: string): Promise<T[]> {
    const keys = await kv.keys(prefix)
    const rows = await Promise.all(keys.map((k) => kv.get<T>(k)))
    return rows.filter((r) => r !== undefined) as T[]
  }

  async function upsertIndex(meta: SpaceMeta) {
    const list = (await kv.get<SpaceIndexEntry[]>(K.spaces)) ?? []
    const entry: SpaceIndexEntry = {
      id: meta.id,
      title: meta.title,
      cover: meta.cover,
      updatedAt: meta.updatedAt,
      sceneCount: meta.sceneCount,
      genre: meta.genre,
    }
    const next = [entry, ...list.filter((e) => e.id !== meta.id)].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    )
    await kv.set(K.spaces, next)
  }

  return {
    idGen,

    async listSpaces(): Promise<SpaceIndexEntry[]> {
      const list = (await kv.get<SpaceIndexEntry[]>(K.spaces)) ?? []
      return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async createSpace(input: CreateSpaceInput): Promise<SpaceMeta> {
      const ts = now()
      const sp = idGen('sp')
      const preset = input.preset ?? 'short'
      const meta: SpaceMeta = {
        id: sp,
        v: 1,
        title: input.title.trim() || '未命名空间',
        cover: input.cover ?? '📖',
        createdAt: ts,
        updatedAt: ts,
        genre: input.genre ?? '通用',
        tone: input.tone ?? '克制',
        pov: input.pov ?? 'third',
        protagId: null,
        settings: {
          charPreset: preset,
          temperature: input.defaults?.temperature ?? 0.9,
          choiceCount: input.defaults?.choiceCount ?? 4,
          recentSummaries: 8,
        },
        hardRules: input.hardRules ?? [],
        mainGoal: input.mainGoal ?? '',
        objectives: input.mainGoal
          ? [
              {
                id: idGen('ob'),
                text: input.mainGoal.slice(0, 60),
                kind: 'main' as const,
                status: 'active' as const,
                atSceneId: null,
                origin: 'user' as const,
              },
            ]
          : [],
        endedAt: null,
        mode: input.mode ?? 'goal',
        scheduled: [],
        sceneCount: 0,
        canonRev: 0,
        activeSceneId: null,
        archiveWatermark: null,
        stats: { calls: 0, inTok: 0, outTok: 0, chars: 0 },
      }
      const world: World = { ...input.world, updatedAt: ts }

      const cast: CastMember[] = input.cast.map((c) => ({
        id: idGen('ch'),
        spaceId: sp,
        personaId: c.personaId ?? null,
        personaRev: c.personaRev ?? null,
        name: c.name,
        aliases: c.aliases ?? [],
        role: c.role ?? 'support',
        status: c.status ?? 'alive',
        statusChangedSceneId: null,
        oneLine: c.oneLine ?? '',
        voice: c.voice ?? '',
        traits: c.traits ?? [],
        secrets: c.secrets ?? [],
        goal: c.goal ?? '',
        abilities: c.abilities ?? [],
        hobbies: c.hobbies ?? [],
        hidden: (c.secrets ?? []).map((text) => ({ text, revealedAt: null })),
        arc: [],
        interactions: c.interactions ?? [],
        firstSeenSceneId: null,
        lastSeenSceneId: null,
        lastSeenPlaceId: null,
        locked: c.locked ?? {},
        origin: c.origin ?? 'user',
        confidence: 1,
        supersededBy: null,
        removedAt: null,
      }))

      const places: Place[] = input.places.map((p) => ({
        id: idGen('pl'),
        spaceId: sp,
        name: p.name,
        kind: p.kind ?? '场所',
        oneLine: p.oneLine ?? '',
        features: p.features ?? [],
        inventory: p.inventory ?? [],
        events: [],
        exits: p.exits ?? [],
        parentId: p.parentId ?? null,
        interactions: p.interactions ?? [],
        coords: p.coords ?? null,
        firstSeenSceneId: null,
        locked: p.locked ?? {},
        supersededBy: null,
        removedAt: null,
      }))

      const protagonist = cast.find((c) => c.role === 'protagonist')
      if (protagonist) meta.protagId = protagonist.id

      await writeAll([
        [K.meta(sp), meta],
        [K.world(sp), world],
        [K.facts(sp), []],
        ...cast.map((c) => [K.cast(sp, c.id), c] as [string, unknown]),
        ...places.map((p) => [K.place(sp, p.id), p] as [string, unknown]),
      ])
      await upsertIndex(meta)

      // 初始快照：回退到第一幕时需要一个可还原的起点
      await kv.set(K.snap(sp, 0), {
        rev: 0,
        sceneId: '',
        sceneIndex: -1,
        world,
        cast,
        places,
        relations: [],
        facts: [],
      })

      return meta
    },

    async loadMeta(sp: string): Promise<SpaceMeta> {
      const meta = await kv.get<SpaceMeta>(K.meta(sp))
      if (!meta) throw new Error(`空间不存在：${sp}`)
      return normalizeMeta(meta)
    },

    async saveMeta(sp: string, meta: SpaceMeta): Promise<void> {
      const next = { ...meta, updatedAt: now() }
      await kv.set(K.meta(sp), next)
      await upsertIndex(next)
    },

    async loadCanon(sp: string): Promise<CanonState> {
      const [world, facts, cast, places, relations] = await Promise.all([
        kv.get<World>(K.world(sp)),
        kv.get<Fact[]>(K.facts(sp)),
        getAll<CastMember>(P.cast(sp)),
        getAll<Place>(P.place(sp)),
        getAll<Relation>(P.rel(sp)),
      ])
      return {
        world: {
          ...(world ?? emptyWorld()),
          rules: world?.rules ?? [],
          factions: world?.factions ?? [],
        },
        // 旧存档缺后来加的数组字段：出口补一次，页面就不必各自防御
        cast: cast.map(normalizeCast),
        places: places.map(normalizePlace),
        relations,
        facts: facts ?? [],
      }
    },

    /**
     * 写入整个 canon。
     *
     * canon 是「按行存 + 前缀扫描读」的，所以这里必须**对账**：
     * 只写不删的话，回退或合并后已经不在 canon 里的行会留在库里，
     * 下次 loadCanon 又全读回来 —— 表现就是「删不掉的人」。
     */
    async saveCanon(sp: string, canon: CanonState): Promise<void> {
      const [oldCast, oldPlaces, oldRels] = await Promise.all([
        kv.keys(P.cast(sp)),
        kv.keys(P.place(sp)),
        kv.keys(P.rel(sp)),
      ])

      const keepCast = new Set(canon.cast.map((c) => K.cast(sp, c.id)))
      const keepPlaces = new Set(canon.places.map((p) => K.place(sp, p.id)))
      const keepRels = new Set(canon.relations.map((r) => K.rel(sp, r.id)))

      await Promise.all(
        [
          ...oldCast.filter((k) => !keepCast.has(k)).map((k) => kv.del(k)),
          ...oldPlaces.filter((k) => !keepPlaces.has(k)).map((k) => kv.del(k)),
          ...oldRels.filter((k) => !keepRels.has(k)).map((k) => kv.del(k)),
        ].map((p) => p),
      )

      await writeAll([
        [K.world(sp), canon.world],
        [K.facts(sp), canon.facts],
        ...canon.cast.map((c) => [K.cast(sp, c.id), c] as [string, unknown]),
        ...canon.places.map((p) => [K.place(sp, p.id), p] as [string, unknown]),
        ...canon.relations.map((r) => [K.rel(sp, r.id), r] as [string, unknown]),
      ])
    },

    async listScenes(sp: string): Promise<Scene[]> {
      const scenes = await getAll<Scene>(P.scene(sp))
      return scenes.sort((a, b) => a.index - b.index)
    },

    async loadText(sp: string, sceneId: string): Promise<string> {
      const row = await kv.get<{ text: string }>(K.text(sp, sceneId))
      return row?.text ?? ''
    },

    /** 改写前的正文；没有改写记录时为 null */
    async loadTextOld(sp: string, sceneId: string): Promise<string | null> {
      const row = await kv.get<{ text: string }>(K.textOld(sp, sceneId))
      return row?.text ?? null
    },

    /** 存旧版（覆盖式：只留最近一份，"撤回一步"是真实需求，"撤回十步"用快照） */
    async saveTextOld(sp: string, sceneId: string, text: string): Promise<void> {
      await kv.set(K.textOld(sp, sceneId), { text })
    },

    /** 撤销改写：换回旧版与当前版对调，连续撤销不会一路退到更早 */
    async revertText(sp: string, sceneId: string): Promise<string | null> {
      const old = await kv.get<{ text: string }>(K.textOld(sp, sceneId))
      if (!old) return null
      const current = await kv.get<{ text: string }>(K.text(sp, sceneId))
      await kv.set(K.text(sp, sceneId), { text: old.text })
      await kv.set(K.textOld(sp, sceneId), { text: current?.text ?? '' })
      return old.text
    },

    /**
     * 写入一幕：正文与元数据分行存，并同步书架索引。
     *
     * 注意：同一幕会被重复保存（补上摘要、合并后重指 participants）。
     * 字数只在**首次写入**时累加，否则每次重存都会把统计翻倍。
     */
    async saveScene(sp: string, scene: Scene, text: string): Promise<void> {
      const previous = await kv.get<Scene>(K.scene(sp, scene.id))
      await writeAll([
        [K.scene(sp, scene.id), scene],
        [K.text(sp, scene.id), { text }],
      ])
      const meta = await kv.get<SpaceMeta>(K.meta(sp))
      if (meta) {
        // max 防止乱序保存把幕数写小（回退时会显式把 sceneCount 改成回退点）
        const committed =
          scene.status === 'committed' ? Math.max(meta.sceneCount, scene.index + 1) : meta.sceneCount
        const next: SpaceMeta = {
          ...meta,
          sceneCount: committed,
          activeSceneId: scene.status === 'committed' ? scene.id : meta.activeSceneId,
          stats: {
            ...meta.stats,
            chars: previous ? meta.stats.chars : meta.stats.chars + text.replace(/\s/g, '').length,
          },
          updatedAt: now(),
        }
        await kv.set(K.meta(sp), next)
        await upsertIndex(next)
      }
    },

    /**
     * 标记「这条我正在追」。
     *
     * 它不改变线索状态（回答与否仍由正文和校对判定），只做两件事：
     * 1. UI 高亮，让玩家知道自己追的是哪条；
     * 2. 过期时给更长的保留期——主动追的线不该和没人理的线一起被放下。
     */
    async markCluePursued(sp: string, clueId: string, at = now()): Promise<boolean> {
      const scenes = await getAll<Scene>(P.scene(sp))
      for (const scene of scenes) {
        const idx = scene.clues.findIndex((c) => c.id === clueId && c.status === 'open')
        if (idx < 0) continue
        const clues = scene.clues.map((c, i) => (i === idx ? { ...c, pursuedAt: at } : c))
        await kv.set(K.scene(sp, scene.id), { ...scene, clues })
        return true
      }
      return false
    },

    /**
     * 把悬太久的线索从「待答」里放下。
     *
     * 为什么需要：实测 12 幕能开出 12 个问题、收线 0 条，账本一封顶就再也开不了新线，
     * 而玩家看到的是 12 条永不回答的问题。放下 ≠ 解答：单列一组，写明"剧里没再提"。
     * 只改 scene 行，不动正文与统计。
     */
    async expireClues(sp: string, currentIndex: number, maxAge = 12): Promise<number> {
      const scenes = await getAll<Scene>(P.scene(sp))
      const touched: Array<[string, unknown]> = []
      let count = 0
      for (const scene of scenes) {
        if (currentIndex - scene.index < maxAge) continue
        let hit = false
        const clues = scene.clues.map((clue) => {
          if (clue.status !== 'open') return clue
          // 主动追过的线多给一倍时间：玩家已经在它身上花过动作，不该和没人理的线同命运
          const age = currentIndex - scene.index
          if (clue.pursuedAt && age < maxAge * 2) return clue
          hit = true
          count++
          return { ...clue, status: 'dropped' as const }
        })
        if (hit) touched.push([K.scene(sp, scene.id), { ...scene, clues }])
      }
      if (touched.length) await writeAll(touched)
      return count
    },

    /**
     * 删除某一幕之后的全部场景（回退用）。
     *
     * 为什么是删除而不是标 orphan：幕号 = 已提交幕数，孤儿只要还占着 index，
     * 回退后继续写就会跳到旧编号（实测：回退到第 1 幕，下一幕成了第 6 幕）。
     * 正文、旧版正文、补丁、快照一起清，时间线才自洽；留档交给导出。
     */
    async deleteScenesAfter(sp: string, index: number): Promise<number> {
      const scenes = await getAll<Scene>(P.scene(sp))
      const doomed = scenes.filter((s) => s.index > index)
      if (!doomed.length) return 0
      const ids = new Set(doomed.map((s) => s.id))

      const patches = await getAll<PatchRecord>(P.patch(sp))
      const snaps = await getAll<CanonSnapshot>(P.snap(sp))
      const keys = [
        ...doomed.flatMap((s) => [K.scene(sp, s.id), K.text(sp, s.id), K.textOld(sp, s.id)]),
        ...patches.filter((p) => ids.has(p.sceneId)).map((p) => K.patch(sp, p.id)),
        ...snaps.filter((x) => x.sceneIndex > index).map((x) => K.snap(sp, x.rev)),
      ]
      await Promise.all(keys.map((k) => kv.del(k)))
      return doomed.length
    },

    // ── 生成图 ──────────────────────────────
    async loadArt(sp: string, kind: ArtKind, id: string): Promise<Art | undefined> {
      return kv.get<Art>(K.art(sp, kind, id))
    },

    async saveArt(sp: string, art: Art): Promise<void> {
      await kv.set(K.art(sp, art.kind, art.id), art)
    },

    async listArt(sp: string): Promise<Art[]> {
      return getAll<Art>(P.art(sp))
    },

    async deleteArt(sp: string, kind: ArtKind, id: string): Promise<void> {
      await kv.del(K.art(sp, kind, id))
    },

    async savePatch(sp: string, patch: PatchRecord): Promise<void> {
      await kv.set(K.patch(sp, patch.id), patch)
    },

    /**
     * 收掉旧线索：线索是挂在幕上的，收线必须回写它**当初所在**的那一幕。
     *
     * 只改 scene 行，不动正文与统计——收线不是叙事事件，不该改变字数。
     * 返回真正被改动的条数，便于调用方校验（0 通常意味着 id 对不上）。
     */
    async resolveClues(sp: string, ids: string[], atSceneId: string): Promise<number> {
      if (!ids.length) return 0
      const want = new Set(ids)
      const scenes = await getAll<Scene>(P.scene(sp))
      const touched: Array<[string, unknown]> = []
      let count = 0
      for (const scene of scenes) {
        let hit = false
        const clues = scene.clues.map((clue) => {
          if (clue.status !== 'open' || !want.has(clue.id)) return clue
          hit = true
          count++
          return { ...clue, status: 'resolved' as const, resolvedAtSceneId: atSceneId }
        })
        if (hit) touched.push([K.scene(sp, scene.id), { ...scene, clues }])
      }
      if (touched.length) await writeAll(touched)
      return count
    },

    async listPatches(sp: string): Promise<PatchRecord[]> {
      const rows = await getAll<PatchRecord>(P.patch(sp))
      return rows.sort((a, b) => a.createdAt - b.createdAt)
    },

    async listMergeProposals(sp: string): Promise<MergeProposal[]> {
      const list = (await kv.get<MergeProposal[]>(K.merges(sp))) ?? []
      return list.filter((m) => m.status === 'pending')
    },

    async saveMergeProposals(sp: string, proposals: MergeProposal[]): Promise<void> {
      await kv.set(K.merges(sp), proposals)
    },

    async saveSnapshot(sp: string, snap: CanonSnapshot): Promise<void> {
      await kv.set(K.snap(sp, snap.rev), snap)
    },

    async loadSnapshot(sp: string, rev: number): Promise<CanonSnapshot | undefined> {
      return kv.get<CanonSnapshot>(K.snap(sp, rev))
    },

    /** 最近一份幕序不超过 targetIndex 的快照（回退用）。 */
    async latestSnapshotBefore(sp: string, targetIndex: number): Promise<CanonSnapshot | undefined> {
      const keys = await kv.keys(P.snap(sp))
      const snaps = (await Promise.all(keys.map((k) => kv.get<CanonSnapshot>(k)))).filter(
        (sn): sn is CanonSnapshot => Boolean(sn),
      )
      const candidates = snaps
        .filter((sn) => (sn.sceneIndex ?? -1) <= targetIndex)
        .sort((a, b) => (b.sceneIndex ?? -1) - (a.sceneIndex ?? -1))
      return candidates[0]
    },

    /** 最近一份不超过 rev 的快照（旧接口，保留兼容）。 */
    async latestSnapshotAtOrBefore(sp: string, rev: number): Promise<CanonSnapshot | undefined> {
      const keys = await kv.keys(P.snap(sp))
      const revs = keys.map(revFromKey).filter((r) => r <= rev).sort((a, b) => b - a)
      if (!revs.length) return undefined
      return kv.get<CanonSnapshot>(K.snap(sp, revs[0]))
    },

    async deleteSpace(sp: string): Promise<void> {
      const prefixes = [P.cast(sp), P.place(sp), P.rel(sp), P.scene(sp), P.text(sp), P.patch(sp), P.snap(sp)]
      for (const prefix of prefixes) {
        const keys = await kv.keys(prefix)
        await Promise.all(keys.map((k) => kv.del(k)))
      }
      await Promise.all([kv.del(K.meta(sp)), kv.del(K.world(sp)), kv.del(K.facts(sp))])
      const list = (await kv.get<SpaceIndexEntry[]>(K.spaces)) ?? []
      await kv.set(K.spaces, list.filter((e) => e.id !== sp))
    },

    async exportBundle(sp: string): Promise<SpaceBundle> {
      const [meta, canon, scenes, patches] = await Promise.all([
        this.loadMeta(sp),
        this.loadCanon(sp),
        this.listScenes(sp),
        this.listPatches(sp),
      ])
      const textEntries = await Promise.all(
        scenes.map(async (s) => [s.id, await this.loadText(sp, s.id)] as const),
      )
      const snapKeys = await kv.keys(P.snap(sp))
      const snapshots = (
        await Promise.all(snapKeys.map((k) => kv.get<CanonSnapshot>(k)))
      ).filter((s): s is CanonSnapshot => Boolean(s))

      return buildBundle({
        arts: await this.listArt(sp),
        space: meta,
        world: canon.world,
        cast: canon.cast,
        places: canon.places,
        relations: canon.relations,
        facts: canon.facts,
        scenes,
        texts: Object.fromEntries(textEntries),
        patches,
        snapshots,
        now: now(),
      })
    },

    /**
     * 组装导出的数据视图。UI 预览与下载文件都走这里，
     * 保证「看到的」和「导出的」是同一份数据。
     */
    async exportDataSet(sp: string): Promise<ExportDataSet> {
      const [space, canon, scenes] = await Promise.all([
        this.loadMeta(sp),
        this.loadCanon(sp),
        this.listScenes(sp),
      ])
      const withText = await Promise.all(
        scenes.map(async (scene) => ({ scene, text: await this.loadText(sp, scene.id) })),
      )
      return {
        space,
        world: canon.world,
        cast: canon.cast,
        places: canon.places,
        relations: canon.relations,
        facts: canon.facts,
        scenes: withText,
      }
    },

    /** 导入总是生成新空间（导入为副本），绝不覆盖现有存档。 */
    async importBundle(bundle: SpaceBundle): Promise<SpaceMeta> {
      const migrated = migrate(bundle)
      const ts = now()
      const sp = idGen('sp')
      const meta: SpaceMeta = {
        ...migrated.space,
        id: sp,
        title: `${migrated.space.title}（副本）`,
        createdAt: ts,
        updatedAt: ts,
        archiveWatermark: null,
      }
      const rebind = <T extends { spaceId: string }>(rows: T[]): T[] =>
        rows.map((r) => ({ ...r, spaceId: sp }))

      await writeAll([
        [K.meta(sp), meta],
        [K.world(sp), migrated.world],
        [K.facts(sp), migrated.facts],
        ...rebind(migrated.cast).map((c) => [K.cast(sp, c.id), c] as [string, unknown]),
        ...rebind(migrated.places).map((p) => [K.place(sp, p.id), p] as [string, unknown]),
        ...rebind(migrated.relations).map((r) => [K.rel(sp, r.id), r] as [string, unknown]),
        ...rebind(migrated.scenes).map((s) => [K.scene(sp, s.id), s] as [string, unknown]),
        ...Object.entries(migrated.texts).map(([id, text]) => [K.text(sp, id), { text }] as [string, unknown]),
        ...rebind(migrated.patches).map((p) => [K.patch(sp, p.id), p] as [string, unknown]),
        // 快照也要带过来：没有它，导入后的副本回退不了（提示"没有可用的档案快照"）
        ...migrated.snapshots.map((snap) => [K.snap(sp, snap.rev), snap] as [string, unknown]),
      ])

      // 图跟着存档走：换设备/重装浏览器后封面与立绘还在。
      // 封面的 id 就是空间 id，必须跟着换新 id，否则副本的封面永远读不到。
      const arts = (migrated.arts ?? []).map((art) =>
        art.kind === 'cover' ? { ...art, id: sp } : art,
      )
      if (arts.length) {
        await Promise.all(arts.map((art) => kv.set(K.art(sp, art.kind, art.id), art)))
      }

      // 旧存档没带快照时补一份起点，否则回退到第一幕会直接失败
      if (!migrated.snapshots.length) {
        await kv.set(K.snap(sp, 0), {
          rev: 0,
          sceneId: '',
          sceneIndex: -1,
          world: migrated.world,
          cast: migrated.cast,
          places: migrated.places,
          relations: migrated.relations,
          facts: migrated.facts,
        })
      }

      await upsertIndex(meta)
      return meta
    },

    // ── 人物库（跨空间） ──────────────────────────────

    async listPersonas(): Promise<PersonaIndexEntry[]> {
      const list = (await kv.get<PersonaIndexEntry[]>(K.personas)) ?? []
      // 出口归一：早期版本的原型索引没有 tags 字段，页面按 `tags.length` 渲染会直接白屏
      return [...list]
        .map((p) => ({ ...p, tags: p.tags ?? [], oneLine: p.oneLine ?? '' }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },

    async loadPersona(id: string): Promise<Persona | undefined> {
      const raw = await kv.get<Persona>(K.persona(id))
      return raw ? normalizePersona(raw) : undefined
    },

    async savePersona(persona: Persona): Promise<Persona> {
      const ts = now()
      const next: Persona =
        persona.createdAt === ts && persona.updatedAt === 0
          ? { ...persona, updatedAt: ts }
          : { ...persona, rev: persona.rev + 1, updatedAt: ts }
      await kv.set(K.persona(next.id), next)
      const list = (await kv.get<PersonaIndexEntry[]>(K.personas)) ?? []
      const entry: PersonaIndexEntry = {
        id: next.id,
        name: next.name,
        oneLine: next.oneLine,
        tags: next.tags,
        updatedAt: next.updatedAt,
      }
      await kv.set(K.personas, [entry, ...list.filter((e) => e.id !== next.id)])
      return next
    },

    async deletePersona(id: string): Promise<void> {
      await kv.del(K.persona(id))
      const list = (await kv.get<PersonaIndexEntry[]>(K.personas)) ?? []
      await kv.set(K.personas, list.filter((e) => e.id !== id))
    },
  }
}

export type SpaceRepo = ReturnType<typeof createRepo>
