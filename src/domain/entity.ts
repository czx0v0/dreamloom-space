/**
 * 实体消解：把正文里的一个称呼（ref）落到档案里的某个人/某个地点上。
 *
 * 分三层，越往下越不确定，处理方式必须不同：
 *  1. exact  —— 归一化后与 name 或某个 alias 完全相同 → 直接命中（确定）
 *  2. similar —— 名字相近但不等 → **绝不自动合并**，产出一条待确认的合并建议
 *  3. new    —— 没有候选 → 新建
 *
 * 为什么第 2 层不自动合并：
 * 中文两字名共用姓氏太常见（李雷/李雪、王刚/王钢），自动合并会把两个人的
 * 经历缝在一起，而这种错误不可逆——玩家看到的是"这个人怎么突然多了一段记忆"。
 * 所以由「消歧 agent」给判断 + 玩家一键确认，机器只提议。
 */

import { isSameName, isSimilarName, normalizeName } from './alias'
import type { CastMember, MergeProposal, Persona } from './types'

export type ResolveStatus = 'exact' | 'similar' | 'new'

export interface ResolveCandidate {
  id: string
  name: string
  /** 为什么被列为候选 */
  reason: 'similar-name' | 'shared-alias'
  score: number
}

export interface ResolveResult {
  status: ResolveStatus
  /** 仅 exact 时非空 */
  id: string | null
  /** similar 时的候选，供消歧 agent 与玩家判断 */
  candidates: ResolveCandidate[]
}

/**
 * 别名索引：归一化名 → 实体 id。
 * 这是缓存而不是真相源（真相是 CastMember.name + aliases），
 * 每次档案变动后重建即可，避免维护两套真相。
 */
export function buildAliasIndex(cast: CastMember[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const member of cast) {
    if (member.removedAt !== null || member.supersededBy !== null) continue
    for (const alias of [member.name, ...member.aliases]) {
      const key = normalizeName(alias)
      if (!key) continue
      // 先到先得：同名冲突说明档案本身有问题，交给 proposeMerges 暴露
      if (!index.has(key)) index.set(key, member.id)
    }
  }
  return index
}

/** 用原始称呼查索引（内部做归一化，避免调用方各自 remember 这一步）。 */
export function lookupAlias(index: Map<string, string>, ref: string): string | null {
  const key = normalizeName(ref)
  if (!key) return null
  return index.get(key) ?? null
}

export function resolveEntity(
  ref: string,
  cast: CastMember[],
  index?: Map<string, string>,
): ResolveResult {
  const key = normalizeName(ref)
  if (!key) return { status: 'new', id: null, candidates: [] }

  const aliasIndex = index ?? buildAliasIndex(cast)
  const exactId = aliasIndex.get(key)
  if (exactId) return { status: 'exact', id: exactId, candidates: [] }

  const candidates: ResolveCandidate[] = []
  for (const member of cast) {
    if (member.removedAt !== null || member.supersededBy !== null) continue
    const names = [member.name, ...member.aliases]
    if (names.some((n) => isSimilarName(n, ref))) {
      candidates.push({ id: member.id, name: member.name, reason: 'similar-name', score: 0.6 })
      continue
    }
    // 共享一段别名（如「林老板」与「林老板儿」被归一化成不同串但共享前缀）
    if (
      names.some((n) => {
        const a = normalizeName(n)
        return a.length >= 2 && key.length >= 2 && (a.includes(key) || key.includes(a))
      })
    ) {
      candidates.push({ id: member.id, name: member.name, reason: 'shared-alias', score: 0.4 })
    }
  }

  if (candidates.length === 0) return { status: 'new', id: null, candidates: [] }
  return {
    status: 'similar',
    id: null,
    candidates: candidates.sort((a, b) => b.score - a.score).slice(0, 3),
  }
}

/** 档案内部的自检：哪些实体之间可能存在重复。 */
export function proposeMerges(
  cast: CastMember[],
  spaceId: string,
  now: number,
  idGen: (prefix: string) => string,
): MergeProposal[] {
  const active = cast.filter((c) => c.removedAt === null && c.supersededBy === null)
  const proposals: MergeProposal[] = []
  const seen = new Set<string>()

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]
      const b = active[j]
      const pairKey = [a.id, b.id].sort().join('|')
      if (seen.has(pairKey)) continue

      const namesA = [a.name, ...a.aliases]
      const namesB = [b.name, ...b.aliases]
      const exactAliasHit = namesA.some((x) => namesB.some((y) => isSameName(x, y)))
      const similarHit =
        namesA.some((x) => namesB.some((y) => isSimilarName(x, y))) ||
        isSimilarName(a.name, b.name)

      if (!exactAliasHit && !similarHit) continue
      seen.add(pairKey)

      const [first, second] = [a, b].sort((x, y) => x.id.localeCompare(y.id))
      proposals.push({
        id: idGen('mg'),
        spaceId,
        aId: first.id,
        bId: second.id,
        reason: exactAliasHit ? 'shared-alias' : 'similar-name',
        evidence: exactAliasHit
          ? `两者共用同一个称呼「${first.name}」/「${second.name}」`
          : `「${first.name}」与「${second.name}」名字相近`,
        confidence: exactAliasHit ? 0.9 : 0.5,
        status: 'pending',
        createdAt: now,
      })
    }
  }
  return proposals
}

/**
 * 从正文里推出「这一幕有哪些角色在场」。
 *
 * 用名字/别名做字面匹配，不做指代消解（"他"归谁）——那需要模型判断且容易错。
 * 宁可漏掉一个只说"他"的人，也不要把错的 id 写进 participants 污染角色线归属。
 * 死亡角色仍然算在场：他可能就在场，只是不能再说话。
 */
export function mentionCast(cast: CastMember[], text: string): string[] {
  if (!text) return []
  const hits: Array<{ id: string; at: number }> = []
  for (const member of cast) {
    if (member.removedAt !== null || member.supersededBy !== null) continue
    let earliest = -1
    for (const alias of [member.name, ...member.aliases]) {
      const key = (alias ?? '').trim()
      if (key.length < 2) continue
      const at = text.indexOf(key)
      if (at >= 0 && (earliest < 0 || at < earliest)) earliest = at
    }
    if (earliest >= 0) hits.push({ id: member.id, at: earliest })
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.id)
}

/** 从原型导入时，判断这个人是否已经在本空间里了。 */
export function alreadyImported(cast: CastMember[], persona: Persona): CastMember | null {
  return (
    cast.find(
      (c) =>
        c.removedAt === null &&
        (c.personaId === persona.id || isSameName(c.name, persona.name)),
    ) ?? null
  )
}
