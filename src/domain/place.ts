/**
 * 地点层级。
 *
 * 平表时 prompt 会写成「你现在在哪：二楼里间」——读者不知道二楼里间在哪儿。
 * 加一层 `parentId` 就能说成「三号仓库 / 侧门小屋」，代价只是几个纯函数。
 */

import { normalizeName } from './alias'
import type { Place } from './types'

/** 最多 3 层（城 → 建筑 → 房间）。再深对叙事没有收益，只增加 prompt 噪音。 */
export const MAX_PLACE_DEPTH = 3

/** 从顶层到当前地点的路径（含自身），深度受 MAX_PLACE_DEPTH 限制。 */
export function ancestorsOf(places: Place[], id: string | null): Place[] {
  if (!id) return []
  const byId = new Map(places.map((p) => [p.id, p]))
  const chain: Place[] = []
  let cursor = byId.get(id)
  const guard = new Set<string>()
  while (cursor && !guard.has(cursor.id) && chain.length < MAX_PLACE_DEPTH) {
    guard.add(cursor.id)
    chain.unshift(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return chain
}

/** 「三号仓库 / 侧门小屋」 */
export function placePath(places: Place[], id: string | null): string {
  return ancestorsOf(places, id)
    .map((p) => p.name)
    .join(' / ')
}

/** 该地点是否在另一地点之下（含自身）。用于「在同一栋楼里算不算在一起」。 */
export function isWithin(places: Place[], placeId: string | null, ancestorId: string): boolean {
  return ancestorsOf(places, placeId).some((p) => p.id === ancestorId)
}

/**
 * 按名字找地点，**取名字最长的那个**。
 *
 * 「侧门小屋」和「三号仓库」都登记过时，正文里写"进了三号仓库的侧门小屋"，
 * 应该落到更具体的那个——否则位置永远停在粗粒度上。
 */
export function resolvePlaceRef(
  places: Place[],
  ref: string,
): { place: Place; exact: boolean } | null {
  const key = normalizeName(ref)
  if (!key) return null
  const alive = places.filter((p) => p.removedAt === null && p.supersededBy === null)
  const exact = alive.filter((p) => normalizeName(p.name) === key)
  if (exact.length) {
    // 同名多个时取名字最长的（通常是更具体的那条路径）
    return { place: exact.sort((a, b) => b.name.length - a.name.length)[0], exact: true }
  }
  // 模糊匹配的排序依据：
  //  1. 名字出现在 ref 里的（"三号仓库的侧门小屋" 里的 "侧门小屋"）——
  //     越靠后越接近中心词。中文地点是「大地点 + 的 + 小地点」，中心词在最后；
  //  2. 只能反过来的（ref="仓库"、name="三号仓库"）——越短越精确。
  const scored: Array<{ place: Place; score: number }> = []
  for (const place of alive) {
    const n = normalizeName(place.name)
    if (n.length < 2) continue
    const at = key.lastIndexOf(n)
    if (at >= 0) {
      scored.push({ place, score: 1000 + at * 10 + n.length })
      continue
    }
    if (n.includes(key)) {
      scored.push({ place, score: 1000 - n.length })
    }
  }
  if (!scored.length) return null
  scored.sort((a, b) => b.score - a.score)
  return { place: scored[0].place, exact: false }
}
