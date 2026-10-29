/**
 * 应用抽取补丁。纯函数、幂等、永不物理删除。
 *
 * 四道闸门：
 *  1. locked 字段不允许被 patch 改（玩家手改过的就是权威）
 *  2. 状态单调：dead 不能回到 alive
 *  3. name 不允许被改，只能追加 aliases（改名是玩家的事）
 *  4. 关系以 edgeKey 幂等，强度取 max 而非累加
 */

import { hashText, isSimilarName, normalizeName } from './alias'
import { textSimilarity } from './text'
import { resolvePlaceRef } from './place'
import type {
  ArcBeat,
  ArcKind,
  CanonState,
  Fact,
  FactKind,
  CastMember,
  CastStatus,
  Clue,
  ClueThread,
  Objective,
  OpResult,
  PatchOp,
  Place,
  PlaceEvent,
  Relation,
  Strength,
} from './types'

export interface ApplyContext {
  spaceId: string
  sceneId: string
  now: number
  /** 该幕已有的线索，用于去重 */
  existingClues: Clue[]
  idGen: (prefix: string) => string
  /** 单个角色故事线保留条数 */
  maxArc?: number
  /** 单个地点事件保留条数 */
  maxPlaceEvents?: number
  /** 事实账保留条数 */
  maxFacts?: number
  /** 视角人物（主角），move-to 未指明 who 时落到他身上 */
  protagId?: string | null
  /**
   * 全空间已开的线索（含本幕），用于全局上限与跨幕相似去重。
   * 不传则退化为「只按本幕去重」——旧调用方不会因此出错。
   */
  existingOpenClues?: Clue[]
  /** 全局未收上限，默认 12 */
  maxOpenClues?: number
  /** 当前目标列表。目标属于 SpaceMeta 而不是 canon，所以由调用方传进传出。 */
  objectives?: Objective[]
}

export interface ApplyOutcome {
  state: CanonState
  clues: Clue[]
  /** 被收掉的**旧**线索 id（不在本幕）；调用方负责回写它所在的那一幕 */
  resolvedClueIds: string[]
  report: OpResult[]
  warnings: string[]
  /** 本次补丁后的位置（最后一条 move-to 的目标）；没有移动则为 null */
  placeId: string | null
  /** 变更后的目标列表；没有目标类 op 时为 undefined（调用方不必回写） */
  objectives?: Objective[]
}

/** 线索相似度阈值（覆盖度）。见 text.ts 里为什么是覆盖度而不是 Jaccard。 */
const SIMILAR_CLUE = 0.8

function cloneCast(c: CastMember): CastMember {  return {
    ...c,
    aliases: [...c.aliases],
    traits: [...c.traits],
    secrets: [...c.secrets],
    abilities: [...c.abilities],
    hobbies: [...c.hobbies],
    hidden: c.hidden.map((h) => ({ ...h })),
    arc: c.arc.map((b) => ({ ...b })),
    interactions: [...c.interactions],
    locked: { ...c.locked },
  }
}

function clonePlace(p: Place): Place {
  return {
    ...p,
    features: [...p.features],
    inventory: [...p.inventory],
    events: p.events.map((e) => ({ ...e })),
    exits: [...p.exits],
    interactions: [...p.interactions],
    locked: { ...p.locked },
  }
}

/** 故事线的保留优先级：失去/转折最该留下，寒暄最可丢。 */
const ARC_PRIORITY: Record<ArcKind, number> = {
  loss: 3,
  turn: 3,
  reveal: 2,
  gain: 1,
  meeting: 0,
}

const FACT_PRIORITY: Record<FactKind, number> = {
  promise: 3,
  number: 3,
  object: 2,
  place: 1,
  state: 1,
  other: 0,
}

function capFacts(list: Fact[], max: number): Fact[] {
  if (list.length <= max) return list
  const keep = new Set(
    [...list]
      .sort((a, b) => {
        const activeDiff = (a.status === 'active' ? 1 : 0) - (b.status === 'active' ? 1 : 0)
        if (activeDiff !== 0) return -activeDiff
        return FACT_PRIORITY[b.kind] - FACT_PRIORITY[a.kind] || b.updatedAt - a.updatedAt
      })
      .slice(0, max),
  )
  return list.filter((f) => keep.has(f))
}

function capByPriority<T extends { at: number }>(
  list: T[],
  max: number,
  priority: (item: T) => number,
): T[] {
  if (list.length <= max) return list
  const keep = new Set(
    [...list]
      .sort((a, b) => priority(b) - priority(a) || b.at - a.at)
      .slice(0, max),
  )
  return list.filter((item) => keep.has(item))
}

/**
 * 把模型给的称呼解析成线索归属。
 *
 * 模型只知道名字，不知道 id，所以这里做一次解析：命中角色/地点就挂到实体上，
 * 认不出来就归主线——**绝不丢**，一条伏笔没有归属比归错更糟（后者只是显示不精确）。
 */
function resolveThread(raw: string | undefined, state: CanonState): ClueThread {
  const label = (raw ?? '').trim()
  if (!label || label === '主线' || label === 'main' || label === '主线目标') {
    return { kind: 'main', id: null, label: '主线' }
  }
  const cast = state.cast.find(
    (c) =>
      c.removedAt === null &&
      (normalizeName(c.name) === normalizeName(label) ||
        c.aliases.some((a) => normalizeName(a) === normalizeName(label))),
  )
  if (cast) return { kind: 'cast', id: cast.id, label: cast.name }
  const place = state.places.find(
    (p) => p.removedAt === null && normalizeName(p.name) === normalizeName(label),
  )
  if (place) return { kind: 'place', id: place.id, label: place.name }
  return { kind: 'main', id: null, label: '主线' }
}

export function cloneCanon(state: CanonState): CanonState {
  return {
    world: {
      ...state.world,
      rules: [...state.world.rules],
      factions: [...state.world.factions],
    },
    cast: state.cast.map(cloneCast),
    places: state.places.map(clonePlace),
    relations: state.relations.map((r) => ({ ...r })),
    facts: state.facts.map((f) => ({ ...f })),
  }
}

function findCast(cast: CastMember[], ref: string): CastMember | null {
  const n = normalizeName(ref)
  if (!n) return null
  return (
    cast.find(
      (c) =>
        c.removedAt === null &&
        (normalizeName(c.name) === n || c.aliases.some((a) => normalizeName(a) === n)),
    ) ?? null
  )
}

function findPlace(places: Place[], ref: string): Place | null {
  const n = normalizeName(ref)
  if (!n) return null
  return places.find((p) => p.removedAt === null && normalizeName(p.name) === n) ?? null
}

/** 只用于提示，绝不用于合并：本地甲/本地乙 这类名字相近但可能是两个人。 */
function similarCastName(cast: CastMember[], ref: string): string | null {
  for (const c of cast) {
    if (c.removedAt !== null) continue
    if (isSimilarName(c.name, ref)) return c.name
    for (const alias of c.aliases) {
      if (isSimilarName(alias, ref)) return c.name
    }
  }
  return null
}

/**
 * 合并列表：只增不减、去重、封顶。
 *
 * 属性类字段（性格 / 能力 / 爱好）都走这一套：
 * 减少会让"这个人本来会什么"凭空丢失，而无限增加会让每个人最后都变成一串形容词。
 */
function unionList(
  current: string[],
  incoming: string[] | undefined,
  max: number,
  itemMax = 10,
): string[] {
  if (!incoming?.length) return current
  const seen = new Set(current.map((t) => t.trim()))
  const out = [...current]
  for (const t of incoming) {
    const v = t.trim().slice(0, itemMax)
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
    if (out.length >= max) break
  }
  return out
}

const unionTraits = (current: string[], incoming?: string[]) => unionList(current, incoming, 8, 8)

export function applyPatch(state: CanonState, ops: PatchOp[], ctx: ApplyContext): ApplyOutcome {
  /** 目标列表按需克隆：没有目标类 op 时不产生新数组，调用方也就不会白写一次库 */
  let objectives: Objective[] | null = null
  const targets = (): Objective[] => {
    if (!objectives) objectives = (ctx.objectives ?? []).map((o) => ({ ...o }))
    return objectives
  }
  /** move-to 的目标；最后一条生效的移动决定这一幕发生在哪 */
  let movedTo: string | null = null
  /** 本批已经加进去的线索数，用于全局上限 */
  let addedClues = 0
  const next = cloneCanon(state)
  const report: OpResult[] = []
  const warnings: string[] = []
  const clues: Clue[] = ctx.existingClues.map((c) => ({ ...c }))
  const resolvedClueIds: string[] = []
  const clueIndex = new Set(clues.map((c) => hashText(normalizeName(c.text))))

  for (const op of ops) {
    if (op.op === 'upsert-cast') {
      const hit = findCast(next.cast, op.ref)
      if (!hit) {
        const similar = similarCastName(next.cast, op.ref)
        if (similar) {
          warnings.push(`「${op.ref}」与「${similar}」名字相近，已分开记录，可在档案库手动合并`)
        }
        const status = (op.value.status ?? 'alive') as CastStatus
        const created: CastMember = {
          id: ctx.idGen('ch'),
          spaceId: ctx.spaceId,
          personaId: null,
          personaRev: null,
          name: (op.value.name ?? op.ref).trim().slice(0, 12),
          aliases: [],
          role: op.value.role ?? 'support',
          status,
          statusChangedSceneId: status === 'dead' ? ctx.sceneId : null,
          oneLine: op.value.oneLine ?? '',
          voice: op.value.voice ?? '',
          traits: op.value.traits ? [...op.value.traits] : [],
          secrets: [],
          goal: op.value.goal ?? '',
          abilities: op.value.abilities ? [...op.value.abilities] : [],
          hobbies: op.value.hobbies ? [...op.value.hobbies] : [],
          hidden: [],
          arc: [],
          interactions: [],
          firstSeenSceneId: ctx.sceneId,
          lastSeenSceneId: ctx.sceneId,
          lastSeenPlaceId: null,
          locked: {},
          origin: 'extract',
          confidence: op.confidence ?? 0.6,
          supersededBy: null,
          removedAt: null,
        }
        next.cast.push(created)
        report.push({ op: op.op, ref: op.ref, result: 'applied', reason: 'created' })
        continue
      }

      const target = hit
      let changed = false
      let blocked = ''

      // name 永不被改，只追加 alias
      if (op.value.name) {
        const incoming = op.value.name.trim().slice(0, 12)
        const dup =
          normalizeName(incoming) === normalizeName(target.name) ||
          target.aliases.some((a) => normalizeName(a) === normalizeName(incoming))
        if (!dup && incoming) {
          target.aliases.push(incoming)
          changed = true
        }
      }

      if (op.value.status && op.value.status !== target.status) {
        if (target.locked.status) {
          blocked = 'locked-by-user'
        } else if (target.status === 'dead' && op.value.status === 'alive') {
          blocked = 'dead-cannot-revive'
        } else {
          target.status = op.value.status
          target.statusChangedSceneId = ctx.sceneId
          changed = true
        }
      }

      if (op.value.oneLine && !target.oneLine && !target.locked.oneLine) {
        target.oneLine = op.value.oneLine
        changed = true
      }
      if (op.value.voice && !target.voice) {
        target.voice = op.value.voice
        changed = true
      }
      if (op.value.goal) {
        target.goal = op.value.goal
        changed = true
      }
      if (op.value.role && target.role === 'extra') {
        target.role = op.value.role
        changed = true
      }
      const mergedAbilities = unionList(target.abilities, op.value.abilities, 6)
      if (mergedAbilities.length !== target.abilities.length) {
        target.abilities = mergedAbilities
        changed = true
      }
      const mergedHobbies = unionList(target.hobbies, op.value.hobbies, 4)
      if (mergedHobbies.length !== target.hobbies.length) {
        target.hobbies = mergedHobbies
        changed = true
      }
      const mergedTraits = unionTraits(target.traits, op.value.traits)
      if (mergedTraits.length !== target.traits.length) {
        target.traits = mergedTraits
        changed = true
      }
      target.lastSeenSceneId = ctx.sceneId
      target.confidence = Math.max(target.confidence, op.confidence ?? 0.6)

      if (blocked) {
        report.push({ op: op.op, ref: op.ref, result: 'rejected', reason: blocked })
      } else {
        report.push({
          op: op.op,
          ref: op.ref,
          result: changed ? 'applied' : 'skipped',
          reason: changed ? 'merged' : 'no-change',
        })
      }
      continue
    }

    if (op.op === 'upsert-place') {
      const hit = findPlace(next.places, op.ref)
      if (!hit) {
        const parent = op.parent ? resolvePlaceRef(next.places, op.parent)?.place : null
        const created: Place = {
          id: ctx.idGen('pl'),
          spaceId: ctx.spaceId,
          name: (op.value.name ?? op.ref).trim().slice(0, 12),
          kind: op.value.kind ?? '场所',
          oneLine: op.value.oneLine ?? '',
          features: op.value.features ? [...op.value.features] : [],
          inventory: op.value.inventory ? [...op.value.inventory] : [],
          events: [],
          exits: [],
          parentId: parent ? parent.id : null,
          interactions: [],
          coords: null,
          firstSeenSceneId: ctx.sceneId,
          locked: {},
          supersededBy: null,
          removedAt: null,
        }
        next.places.push(created)
        report.push({ op: op.op, ref: op.ref, result: 'applied', reason: 'created' })
        continue
      }
      const place = hit
      let changed = false
      if (op.value.kind && !place.kind) {
        place.kind = op.value.kind
        changed = true
      }
      if (op.value.oneLine && !place.oneLine && !place.locked.oneLine) {
        place.oneLine = op.value.oneLine
        changed = true
      }
      if (op.value.features?.length) {
        const seen = new Set(place.features)
        for (const f of op.value.features) {
          if (!seen.has(f)) {
            place.features.push(f)
            seen.add(f)
            changed = true
          }
        }
      }
      if (op.value.inventory?.length) {
        const seen = new Set(place.inventory)
        for (const item of op.value.inventory) {
          if (!seen.has(item)) {
            place.inventory.push(item)
            seen.add(item)
            changed = true
          }
        }
      }
      report.push({
        op: op.op,
        ref: op.ref,
        result: changed ? 'applied' : 'skipped',
        reason: changed ? 'merged' : 'no-change',
      })
      continue
    }

    if (op.op === 'upsert-relation') {
      const a = findCast(next.cast, op.a)
      const b = findCast(next.cast, op.b)
      if (!a || !b) {
        report.push({
          op: op.op,
          ref: `${op.a}↔${op.b}`,
          result: 'skipped',
          reason: 'unknown-entity',
        })
        warnings.push(`关系 ${op.a}↔${op.b} 有一端不在人物表中，已跳过`)
        continue
      }
      if (a.id === b.id) {
        report.push({ op: op.op, ref: `${op.a}↔${op.b}`, result: 'skipped', reason: 'self' })
        continue
      }
      const [idA, idB] = [a.id, b.id].sort()
      const edgeKey = `${idA}|${idB}|${op.kind}`
      const existing = next.relations.find((r) => r.edgeKey === edgeKey)
      const incoming = (op.strength ?? 3) as Strength
      if (existing) {
        const before = existing.strength
        existing.strength = Math.max(existing.strength, incoming) as Strength
        if (!existing.note && op.note) existing.note = op.note
        report.push({
          op: op.op,
          ref: edgeKey,
          result: existing.strength !== before ? 'applied' : 'skipped',
          reason: existing.strength !== before ? 'strengthened' : 'no-change',
        })
      } else {
        const relation: Relation = {
          id: ctx.idGen('rl'),
          spaceId: ctx.spaceId,
          aId: idA,
          bId: idB,
          kind: op.kind,
          strength: incoming,
          note: op.note ?? '',
          edgeKey,
          firstSeenSceneId: ctx.sceneId,
        }
        next.relations.push(relation)
        report.push({ op: op.op, ref: edgeKey, result: 'applied', reason: 'created' })
      }
      continue
    }

    if (op.op === 'append-clue') {
      const key = hashText(normalizeName(op.text))
      if (clueIndex.has(key)) {
        report.push({ op: op.op, ref: op.text.slice(0, 12), result: 'skipped', reason: 'duplicate' })
        continue
      }

      // 措辞不同但说的是同一件事：跨幕也要抓，否则同一批货会被记三次
      const pool = [...(ctx.existingOpenClues ?? []), ...clues]
      const twin = pool.find(
        (c) => c.status === 'open' && textSimilarity(c.text, op.text) >= SIMILAR_CLUE,
      )
      if (twin) {
        report.push({
          op: op.op,
          ref: op.text.slice(0, 12),
          result: 'skipped',
          reason: 'similar',
        })
        continue
      }

      // 全局上限：确定性计数不交给模型，模型只会一路开新坑。
      // 本幕收掉的旧线要从存量里扣掉，否则「收一条开一条」也会被误判为溢出。
      const maxOpen = ctx.maxOpenClues ?? 12
      const openNow =
        (ctx.existingOpenClues ?? []).length - resolvedClueIds.length + addedClues
      if (openNow >= maxOpen) {
        report.push({
          op: op.op,
          ref: op.text.slice(0, 12),
          result: 'skipped',
          reason: 'clue-overflow',
        })
        continue
      }
      // 一幕最多开两条：再多就是模型在把剧情复述成问题清单
      if (addedClues >= 2) {
        report.push({
          op: op.op,
          ref: op.text.slice(0, 12),
          result: 'skipped',
          reason: 'clue-burst',
        })
        continue
      }
      addedClues++

      clueIndex.add(key)
      clues.push({
        id: ctx.idGen('cl'),
        kind: op.kind,
        text: op.text,
        thread: resolveThread(op.thread, next),
        sceneId: ctx.sceneId,
        status: 'open',
        resolvedAtSceneId: null,
      })
      report.push({ op: op.op, ref: op.text.slice(0, 12), result: 'applied' })
      continue
    }

    if (op.op === 'append-arc') {
      const target = findCast(next.cast, op.ref)
      if (!target) {
        report.push({ op: op.op, ref: op.ref, result: 'skipped', reason: 'not-found' })
        continue
      }
      const beat: ArcBeat = { sceneId: ctx.sceneId, text: op.text, kind: op.kind, at: ctx.now }
      const duplicated = target.arc.some(
        (b) => b.sceneId === beat.sceneId && normalizeName(b.text) === normalizeName(beat.text),
      )
      if (duplicated) {
        report.push({ op: op.op, ref: op.ref, result: 'skipped', reason: 'duplicate' })
        continue
      }
      const maxArc = ctx.maxArc ?? 12
      const before = target.arc.length
      target.arc = capByPriority([...target.arc, beat], maxArc, (b) => ARC_PRIORITY[b.kind] ?? 0)
      const applied = target.arc.some((b) => b.sceneId === beat.sceneId && b.text === beat.text)
      report.push({
        op: op.op,
        ref: op.ref,
        result: applied ? 'applied' : 'skipped',
        reason: applied ? (target.arc.length === before ? 'capped' : 'appended') : 'evicted',
      })
      continue
    }

    if (op.op === 'append-place-event') {
      const target = findPlace(next.places, op.ref)
      if (!target) {
        report.push({ op: op.op, ref: op.ref, result: 'skipped', reason: 'not-found' })
        continue
      }
      const event: PlaceEvent = { sceneId: ctx.sceneId, text: op.text, at: ctx.now }
      const duplicated = target.events.some(
        (e) => e.sceneId === event.sceneId && normalizeName(e.text) === normalizeName(event.text),
      )
      if (duplicated) {
        report.push({ op: op.op, ref: op.ref, result: 'skipped', reason: 'duplicate' })
        continue
      }
      const maxEvents = ctx.maxPlaceEvents ?? 12
      target.events = capByPriority([...target.events, event], maxEvents, () => 0)
      const applied = target.events.some((e) => e.sceneId === event.sceneId && e.text === event.text)
      report.push({
        op: op.op,
        ref: op.ref,
        result: applied ? 'applied' : 'skipped',
        reason: applied ? 'appended' : 'evicted',
      })
      continue
    }

    if (op.op === 'resolve-clue') {
      // 线索按幕存储，跨幕收线必须把 id 交回给调用方去回写那一幕；
      // 早前这里只在「本幕新开的线索」里找，跨幕收线永远匹配不到，
      // 于是 36 幕跑下来 resolved 一直是 0（见 docs/playtests/）。
      const raw = String(op.ref ?? '').trim()
      const numbered = /^#?(\d{1,2})$/.exec(raw)
      const openExisting = (ctx.existingOpenClues ?? []).filter((c) => c.status === 'open')
      const openLocal = clues.filter((c) => c.status === 'open')
      let local: Clue | undefined
      let remoteId: string | null = null

      if (numbered) {
        const idx = Number(numbered[1]) - 1
        // 编号来自档案员看到的清单，顺序必须与 archiveScene 传给 prompt 的一致
        if (openExisting[idx]) remoteId = openExisting[idx].id
        else if (openLocal[idx]) local = openLocal[idx]
      }

      if (!local && !remoteId) {
        const needle = normalizeName(raw.replace(/^#\d+\s*/, ''))
        if (needle.length >= 2) {
          local = openLocal
            .slice()
            .reverse()
            .find((c) => { const t = normalizeName(c.text); return t.includes(needle) || needle.includes(t) })
          if (!local) {
            const hit = openExisting
              .slice()
              .reverse()
              .find((c) => { const t = normalizeName(c.text); return t.includes(needle) || needle.includes(t) })
            if (hit) remoteId = hit.id
          }
        }
      }

      if (!local && !remoteId) {
        // 兜底：模型把线索换了说法。覆盖度 0.5 以上就认，宁可信其有
        const pool = [...openExisting, ...openLocal]
        const scored = pool
          .map((c) => ({ c, score: textSimilarity(c.text, raw) }))
          .sort((a, b) => b.score - a.score)[0]
        if (scored && scored.score >= 0.5) {
          if (openLocal.includes(scored.c)) local = scored.c
          else remoteId = scored.c.id
        }
      }

      if (!local && !remoteId) {
        report.push({ op: op.op, ref: op.ref, result: 'skipped', reason: 'no-open-clue' })
        continue
      }

      if (local) {
        local.status = 'resolved'
        local.resolvedAtSceneId = ctx.sceneId
      }
      if (remoteId && !resolvedClueIds.includes(remoteId)) resolvedClueIds.push(remoteId)
      report.push({
        op: op.op,
        ref: (local?.text ?? openExisting.find((c) => c.id === remoteId)?.text ?? op.ref).slice(0, 12),
        result: 'applied',
        reason: 'resolved',
      })
      continue
    }

    if (op.op === 'assert-fact') {
      const keyOf = (subject: string, predicate: string) =>
        `${normalizeName(subject)}|${normalizeName(predicate)}`
      const key = keyOf(op.subject, op.predicate)
      const existing = next.facts.find(
        (f) => f.status === 'active' && keyOf(f.subject, f.predicate) === key,
      )
      if (existing && normalizeName(existing.object) === normalizeName(op.object)) {
        report.push({ op: op.op, ref: op.subject, result: 'skipped', reason: 'duplicate' })
        continue
      }
      if (existing) {
        existing.status = 'retracted'
        existing.updatedAt = ctx.now
      }
      next.facts.push({
        id: ctx.idGen('ft'),
        subject: op.subject,
        predicate: op.predicate,
        object: op.object,
        kind: op.kind,
        sceneId: ctx.sceneId,
        status: 'active',
        updatedAt: ctx.now,
      })
      next.facts = capFacts(next.facts, ctx.maxFacts ?? 40)
      report.push({
        op: op.op,
        ref: op.subject,
        result: 'applied',
        reason: existing ? 'superseded' : 'created',
      })
      continue
    }

    if (op.op === 'retract-fact') {
      const needle = normalizeName(op.ref)
      const target = [...next.facts]
        .reverse()
        .find((f) => {
          if (f.status !== 'active') return false
          const all = normalizeName(`${f.subject}${f.predicate}${f.object}`)
          return needle.length >= 2 && all.includes(needle)
        })
      if (!target) {
        report.push({ op: op.op, ref: op.ref, result: 'skipped', reason: 'not-found' })
        continue
      }
      target.status = 'retracted'
      target.updatedAt = ctx.now
      report.push({ op: op.op, ref: op.ref, result: 'applied', reason: 'retracted' })
      continue
    }

    if (op.op === 'add-objective') {
      const text = op.text.trim().slice(0, 60)
      if (!text) {
        report.push({ op: op.op, ref: op.text.slice(0, 12), result: 'skipped', reason: 'empty' })
        continue
      }
      const list = targets()
      // 主线只能有一条，而且由玩家设定：模型加的"主线"会跟真主线并排，
      // 进度条随即失去意义（实测第 12 幕出现两条 main）。没有主线时才允许补一条。
      const kind = op.kind ?? 'side'
      if (kind === 'main' && list.some((o) => o.kind === 'main' && o.status === 'active')) {
        report.push({ op: op.op, ref: text.slice(0, 12), result: 'skipped', reason: 'main-locked' })
        continue
      }
      // 同一件事不要记两条目标。0.8 太松：'去找老瘸子打听那封信' 与
      // '赶在天黑前到矮房找老瘸子问信' 覆盖度只有 0.62，却是同一件事。
      if (list.some((o) => o.status === 'active' && textSimilarity(o.text, text) >= 0.6)) {
        report.push({ op: op.op, ref: text.slice(0, 12), result: 'skipped', reason: 'duplicate' })
        continue
      }
      // 支线最多 3 条在跑：实测里模型会把「借个亮处誊报关单」这种一次性动作
      // 也记成目标，四条目标并排显示时，进度条就没有意义了。
      const sideActive = list.filter((o) => o.kind === 'side' && o.status === 'active').length
      if (kind === 'side' && sideActive >= 3) {
        report.push({ op: op.op, ref: text.slice(0, 12), result: 'skipped', reason: 'objective-cap' })
        continue
      }
      list.push({
        id: ctx.idGen('ob'),
        text,
        kind,
        status: 'active',
        atSceneId: null,
        origin: 'extract',
      })
      report.push({ op: op.op, ref: text.slice(0, 12), result: 'applied', reason: 'created' })
      continue
    }

    if (op.op === 'achieve-objective') {
      const needle = normalizeName(op.ref)
      const list = targets()
      const target = list.find((o) => {
        if (o.status !== 'active') return false
        const text = normalizeName(o.text)
        if (!needle || !text) return false
        // 模型给的是片段（"查清父亲死因"），目标可能更完整，所以两个方向都要判
        return text.includes(needle) || needle.includes(text) || textSimilarity(o.text, op.ref) >= 0.6
      })
      if (!target) {
        report.push({ op: op.op, ref: op.ref, result: 'skipped', reason: 'not-found' })
        continue
      }
      target.status = 'done'
      target.atSceneId = ctx.sceneId
      report.push({ op: op.op, ref: target.text.slice(0, 12), result: 'applied', reason: 'done' })
      continue
    }

    if (op.op === 'reveal-hidden') {
      const target = findCast(next.cast, op.ref)
      if (!target) {
        report.push({ op: op.op, ref: op.ref, result: 'skipped', reason: 'not-found' })
        continue
      }
      const needle = normalizeName(op.what)
      const hidden = target.hidden.find(
        (h) => h.revealedAt === null && (normalizeName(h.text).includes(needle) || needle.includes(normalizeName(h.text))),
      )
      if (hidden) {
        hidden.revealedAt = ctx.sceneId
        report.push({ op: op.op, ref: hidden.text.slice(0, 12), result: 'applied', reason: 'revealed' })
        continue
      }
      // 模型揭示的东西可能没登记过：补一条并直接标为已揭，避免"秘密说了却没入档"
      if (needle.length >= 2) {
        target.hidden.push({ text: op.what.trim().slice(0, 40), revealedAt: ctx.sceneId })
        report.push({ op: op.op, ref: op.what.slice(0, 12), result: 'applied', reason: 'created' })
        continue
      }
      report.push({ op: op.op, ref: op.ref, result: 'skipped', reason: 'empty' })
      continue
    }

    if (op.op === 'move-to') {
      // 用最长匹配：「侧门小屋」和「三号仓库」都登记过时要落到更具体的那个，
      // 否则位置永远停在粗粒度上，层级就白加了
      const hit = resolvePlaceRef(next.places, op.ref)?.place ?? null
      let place: Place
      if (hit) {
        place = hit
      } else {
        // 正文走到了一个还没登记的地方：它存在，补建而不是丢掉这条 op。
        // 丢掉的话玩家会看到「去了某地」但档案里没有，位置永远不前进。
        place = {
          id: ctx.idGen('pl'),
          spaceId: ctx.spaceId,
          name: op.ref.trim().slice(0, 12),
          kind: '场所',
          oneLine: '',
          features: [],
          inventory: [],
          events: [],
          exits: [],
          // 自动建地点时不知道层级：猜错比不猜更糟，留给玩家在档案页手动挂
          parentId: null,
          interactions: [],
          coords: null,
          firstSeenSceneId: ctx.sceneId,
          locked: {},
          supersededBy: null,
          removedAt: null,
        }
        next.places.push(place)
      }

      movedTo = place.id

      const mover = op.who ? findCast(next.cast, op.who) : null
      const target = mover ?? (ctx.protagId ? next.cast.find((c) => c.id === ctx.protagId) : null)
      if (target) target.lastSeenPlaceId = place.id

      report.push({
        op: op.op,
        ref: op.ref,
        result: 'applied',
        reason: hit ? 'moved' : 'created',
      })
      continue
    }

    if (op.op === 'tombstone') {
      if (op.entity === 'cast') {
        const hit = findCast(next.cast, op.ref)
        if (!hit) {
          report.push({ op: op.op, ref: op.ref, result: 'skipped', reason: 'not-found' })
          continue
        }
        if (hit.locked.status) {
          report.push({ op: op.op, ref: op.ref, result: 'rejected', reason: 'locked-by-user' })
          continue
        }
        let changed = false
        if (hit.removedAt === null) {
          hit.removedAt = ctx.now
          changed = true
        }
        if (hit.status !== 'unknown') {
          hit.status = 'unknown'
          hit.statusChangedSceneId = ctx.sceneId
          changed = true
        }
        report.push({
          op: op.op,
          ref: op.ref,
          result: changed ? 'applied' : 'skipped',
          reason: changed ? op.reason : 'no-change',
        })
        continue
      }
      const hit = findPlace(next.places, op.ref)
      if (!hit) {
        report.push({ op: op.op, ref: op.ref, result: 'skipped', reason: 'not-found' })
        continue
      }
      if (hit.removedAt === null) {
        hit.removedAt = ctx.now
        report.push({ op: op.op, ref: op.ref, result: 'applied', reason: op.reason })
      } else {
        report.push({ op: op.op, ref: op.ref, result: 'skipped', reason: 'no-change' })
      }
      continue
    }
  }

  return {
    state: next,
    clues: clues.slice(0, 40),
    resolvedClueIds,
    report,
    warnings,
    placeId: movedTo,
    objectives: objectives ?? undefined,
  }
}
