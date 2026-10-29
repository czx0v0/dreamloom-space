/**
 * 合并两个角色实例。
 *
 * 只在玩家确认合并建议后调用（或引用完全相同导致的高置信场景）。
 * 规则与「谁是赢家」无关，只看数据怎么搬：
 *  - 赢家保留自己的 name，输家的 name 与 aliases 都进赢家的别名表
 *  - 故事线按场景+文本去重后合并，超过上限按优先级裁剪
 *  - 生死取"更死的"：只要一方已死，合并后就是死了（复活是不可接受的错误）
 *  - 关系全部重指到赢家，重指后自环与重复边丢弃
 *  - 输家不删除，置 supersededBy 指向赢家，可追溯
 */

import { hashText, normalizeName } from './alias'
import type { CanonState, CastMember, Relation } from './types'

export interface MergeOutcome {
  state: CanonState
  /** 搬过去的别名数量 */
  aliasesMoved: number
  /** 合并后的故事线条数 */
  arcCount: number
  /** 被重指的关系数量 */
  relationsRepointed: number
  /** 重指后变成自环而丢弃的关系数量 */
  relationsDropped: number
  warnings: string[]
}

const ARC_PRIORITY: Record<string, number> = { loss: 3, turn: 3, reveal: 2, gain: 1, meeting: 0 }

function mergeArc(winner: CastMember, loser: CastMember, maxArc: number) {
  const combined = [...winner.arc, ...loser.arc]
  const seen = new Set<string>()
  const deduped = combined.filter((beat) => {
    const key = `${beat.sceneId}|${hashText(normalizeName(beat.text))}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (deduped.length <= maxArc) return deduped.sort((a, b) => a.at - b.at)
  const keep = new Set(
    [...deduped]
      .sort((a, b) => (ARC_PRIORITY[b.kind] ?? 0) - (ARC_PRIORITY[a.kind] ?? 0) || b.at - a.at)
      .slice(0, maxArc),
  )
  return deduped.filter((b) => keep.has(b)).sort((a, b) => a.at - b.at)
}

export function mergeCast(
  state: CanonState,
  winnerId: string,
  loserId: string,
  now: number,
  maxArc = 12,
): MergeOutcome {
  const warnings: string[] = []
  if (winnerId === loserId) {
    return {
      state,
      aliasesMoved: 0,
      arcCount: 0,
      relationsRepointed: 0,
      relationsDropped: 0,
      warnings: ['不能与自己合并'],
    }
  }

  const cast = state.cast.map((c) => ({
    ...c,
    aliases: [...c.aliases],
    traits: [...c.traits],
    secrets: [...c.secrets],
    arc: c.arc.map((b) => ({ ...b })),
    interactions: [...c.interactions],
    locked: { ...c.locked },
  }))
  const winner = cast.find((c) => c.id === winnerId)
  const loser = cast.find((c) => c.id === loserId)
  if (!winner || !loser) {
    return {
      state,
      aliasesMoved: 0,
      arcCount: 0,
      relationsRepointed: 0,
      relationsDropped: 0,
      warnings: ['合并目标不在档案中'],
    }
  }
  if (loser.supersededBy !== null) {
    return {
      state,
      aliasesMoved: 0,
      arcCount: winner.arc.length,
      relationsRepointed: 0,
      relationsDropped: 0,
      warnings: ['该角色已被合并过'],
    }
  }

  // 别名
  const aliasSeen = new Set([winner.name, ...winner.aliases].map(normalizeName))
  let aliasesMoved = 0
  for (const alias of [loser.name, ...loser.aliases]) {
    const key = normalizeName(alias)
    if (!key || aliasSeen.has(key)) continue
    aliasSeen.add(key)
    winner.aliases.push(alias)
    aliasesMoved++
    if (winner.aliases.length >= 8) break
  }

  // 故事线
  winner.arc = mergeArc(winner, loser, maxArc)

  // 特征 / 秘密 / 交互
  const traitSeen = new Set(winner.traits)
  for (const t of loser.traits) {
    if (traitSeen.has(t) || winner.traits.length >= 8) continue
    winner.traits.push(t)
    traitSeen.add(t)
  }
  const secretSeen = new Set(winner.secrets)
  for (const s of loser.secrets) {
    if (secretSeen.has(s) || winner.secrets.length >= 8) continue
    winner.secrets.push(s)
    secretSeen.add(s)
  }
  const interactionSeen = new Set(winner.interactions)
  for (const i of loser.interactions) {
    if (interactionSeen.has(i) || winner.interactions.length >= 6) continue
    winner.interactions.push(i)
    interactionSeen.add(i)
  }

  // 生死：只要一方已死，合并后就是死
  if (loser.status === 'dead' && winner.status !== 'dead') {
    winner.status = 'dead'
    winner.statusChangedSceneId = loser.statusChangedSceneId
    warnings.push('合并后状态为「已死亡」：一方已死，不能因为合并而复活')
  } else if (loser.status === 'missing' && winner.status === 'alive') {
    winner.status = 'missing'
    winner.statusChangedSceneId = loser.statusChangedSceneId
  }

  // 目标：赢家没有就继承
  if (!winner.goal && loser.goal) winner.goal = loser.goal

  // 关系重指
  const relations: Relation[] = []
  const edgeSeen = new Map<string, Relation>()
  let repointed = 0
  let dropped = 0
  for (const rel of state.relations) {
    const a = rel.aId === loserId ? winnerId : rel.aId
    const b = rel.bId === loserId ? winnerId : rel.bId
    if (a !== rel.aId || b !== rel.bId) repointed++
    if (a === b) {
      dropped++
      continue
    }
    const [idA, idB] = [a, b].sort()
    const edgeKey = `${idA}|${idB}|${rel.kind}`
    const existing = edgeSeen.get(edgeKey)
    if (existing) {
      existing.strength = Math.max(existing.strength, rel.strength) as Relation['strength']
      if (!existing.note && rel.note) existing.note = rel.note
      continue
    }
    const next: Relation = { ...rel, aId: idA, bId: idB, edgeKey }
    edgeSeen.set(edgeKey, next)
    relations.push(next)
  }

  loser.supersededBy = winner.id
  loser.removedAt = now

  const nextWinner = cast.find((c) => c.id === winnerId)!
  return {
    state: {
      ...state,
      cast,
      relations,
    },
    aliasesMoved,
    arcCount: nextWinner.arc.length,
    relationsRepointed: repointed,
    relationsDropped: dropped,
    warnings,
  }
}
