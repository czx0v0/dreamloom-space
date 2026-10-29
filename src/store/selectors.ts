/** 行数据 → 页面视图模型。纯函数，可单测。 */

import type { CanonState, CastMember, Clue, Place, Relation, Scene } from '../domain/types'

export function activeCast(canon: CanonState): CastMember[] {
  return canon.cast.filter((c) => c.removedAt === null && c.supersededBy === null)
}

export function activePlaces(canon: CanonState): Place[] {
  return canon.places.filter((p) => p.removedAt === null && p.supersededBy === null)
}

export interface CastCard {
  id: string
  name: string
  role: CastMember['role']
  status: CastMember['status']
  oneLine: string
  arcCount: number
  lastSeenSceneId: string | null
  relationCount: number
}

export function castCards(canon: CanonState): CastCard[] {
  const active = activeCast(canon)
  return active
    .map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      status: c.status,
      oneLine: c.oneLine,
      arcCount: c.arc.length,
      lastSeenSceneId: c.lastSeenSceneId,
      relationCount: canon.relations.filter((r) => r.aId === c.id || r.bId === c.id).length,
    }))
    .sort((a, b) => {
      const rank = (s: CastCard['status']) => (s === 'alive' ? 0 : s === 'missing' ? 1 : 2)
      return rank(a.status) - rank(b.status) || a.name.localeCompare(b.name, 'zh')
    })
}

/** 在某个地点的在场人物：最近一次出场就在此地，且没死。 */
export function presentCast(canon: CanonState, placeId: string): CastMember[] {
  return activeCast(canon).filter(
    (c) => c.lastSeenSceneId === placeId && c.status !== 'dead',
  )
}

export function relationsOf(canon: CanonState, castId: string): Array<{ other: string; kind: Relation['kind']; strength: number }> {
  const byId = new Map(canon.cast.map((c) => [c.id, c.name]))
  return canon.relations
    .filter((r) => r.aId === castId || r.bId === castId)
    .map((r) => ({
      other: byId.get(r.aId === castId ? r.bId : r.aId) ?? '（已不在档案中）',
      kind: r.kind,
      strength: r.strength,
    }))
}

export interface BeatRow {
  sceneId: string
  index: number
  summary: string
  clueCount: number
  status: Scene['status']
}

export function timeline(scenes: Scene[]): BeatRow[] {
  return [...scenes]
    .filter((s) => s.status === 'committed' || s.status === 'orphan')
    .sort((a, b) => a.index - b.index)
    .map((s) => ({
      sceneId: s.id,
      index: s.index,
      summary: s.summary ?? '（这一幕还没有摘要）',
      clueCount: s.clues.length,
      status: s.status,
    }))
}

export function openClues(scenes: Scene[]): Clue[] {
  return scenes
    .flatMap((s) => s.clues)
    .filter((c) => c.status === 'open')
    .slice(-20)
}

export function activeFacts(canon: CanonState) {
  return canon.facts.filter((f) => f.status === 'active')
}

export interface CanonSummary {
  cast: number
  places: number
  relations: number
  facts: number
  openClues: number
}

export function canonSummary(canon: CanonState, scenes: Scene[]): CanonSummary {
  return {
    cast: activeCast(canon).length,
    places: activePlaces(canon).length,
    relations: canon.relations.length,
    facts: activeFacts(canon).length,
    openClues: openClues(scenes).length,
  }
}
