/**
 * 记忆检索的排序与装配（纯函数）。
 *
 * 混合打分而不是纯语义：纯余弦会把「很久以前一个很像的场景」顶掉当前线索，
 * 在长篇里这是明显干扰。所以加时间近因与实体命中两项。
 */

export interface RecallCandidate {
  sceneId: string
  index: number
  partIndex?: number
  text: string
  /** 向量余弦，keyword 模式下用关键词分代替 */
  cosine: number
  castIds?: string[]
  placeIds?: string[]
}

export interface RecallWeights {
  cosine: number
  recency: number
  entity: number
}

export interface RecallOptions {
  weights: RecallWeights
  minScore: number
  topK: number
  keep: number
  currentIndex: number
  /** 已经在上下文里的幕（最近 N 幕），不重复召回 */
  excludeSceneIds: string[]
  /** 在场人物/地点 id，用于实体命中项 */
  entityIds: string[]
  budgetChars: number
}

export interface Recalled {
  sceneId: string
  index: number
  text: string
  score: number
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export function recencyScore(currentIndex: number, index: number): number {
  if (currentIndex <= 0) return 0
  const gap = Math.max(0, currentIndex - index)
  return clamp01(1 - gap / currentIndex)
}

export function entityScore(candidate: RecallCandidate, entityIds: string[]): number {
  if (!entityIds.length) return 0
  const bag = new Set([...(candidate.castIds ?? []), ...(candidate.placeIds ?? [])])
  if (!bag.size) return 0
  let hit = 0
  for (const id of entityIds) if (bag.has(id)) hit++
  return clamp01(hit / entityIds.length)
}

export function scoreCandidate(candidate: RecallCandidate, opts: RecallOptions): number {
  const w = opts.weights
  const total = w.cosine + w.recency + w.entity || 1
  const s =
    w.cosine * clamp01(candidate.cosine) +
    w.recency * recencyScore(opts.currentIndex, candidate.index) +
    w.entity * entityScore(candidate, opts.entityIds)
  return s / total
}

export function recall(candidates: RecallCandidate[], opts: RecallOptions): Recalled[] {
  const excluded = new Set(opts.excludeSceneIds)

  const scored = candidates
    .filter((c) => !excluded.has(c.sceneId))
    .map((c) => ({ candidate: c, score: scoreCandidate(c, opts) }))
    .filter((x) => x.score >= opts.minScore)
    .sort((a, b) => b.score - a.score || b.candidate.index - a.candidate.index)

  // 同一幕的多个块合并：保留最高分，文本按 partIndex 拼接
  const byScene = new Map<string, { score: number; index: number; parts: RecallCandidate[] }>()
  for (const { candidate, score } of scored) {
    if (byScene.size >= opts.topK && !byScene.has(candidate.sceneId)) break
    const entry = byScene.get(candidate.sceneId)
    if (entry) {
      entry.parts.push(candidate)
      entry.score = Math.max(entry.score, score)
    } else {
      byScene.set(candidate.sceneId, { score, index: candidate.index, parts: [candidate] })
    }
  }

  const merged: Recalled[] = Array.from(byScene.entries()).map(([sceneId, entry]) => ({
    sceneId,
    index: entry.index,
    score: entry.score,
    text: entry.parts
      .sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0))
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join(' … '),
  }))

  merged.sort((a, b) => b.score - a.score)

  // 按字符预算截断
  const out: Recalled[] = []
  let used = 0
  for (const item of merged) {
    if (out.length >= opts.keep) break
    if (used + item.text.length > opts.budgetChars) {
      const room = opts.budgetChars - used
      if (room < 80) break
      out.push({ ...item, text: `${item.text.slice(0, room)}…` })
      break
    }
    out.push(item)
    used += item.text.length
  }
  return out
}

// ── 零依赖关键词召回 ────────────────────────────────────

const STOP = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '就', '都', '也',
  '和', '与', '但', '而', '被', '把', '给', '让', '一个', '什么', '怎么', '自己',
])

/** 中文按 2-gram 切，拉丁按词切。用于 keyword 模式的相似度。 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = (text ?? '').toLowerCase()
  for (const word of lower.match(/[a-z0-9]{2,}/g) ?? []) out.push(word)
  for (const run of lower.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (run.length === 1) {
      if (!STOP.has(run)) out.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) {
      const gram = run.slice(i, i + 2)
      if (!STOP.has(gram)) out.push(gram)
    }
  }
  return out
}

/**
 * 关键词相似度 0–1。
 * 失忆最常见的形态是「某个名字/物件再也没被提到」，这种召回关键词就能解决，
 * 所以它值得有一个不依赖任何模型的实现。
 */
export function keywordScore(query: string, text: string): number {
  const trimmed = (query ?? '').trim()
  if (!trimmed) return 0
  const q = Array.from(new Set(tokenize(trimmed)))
  const hay = new Set(tokenize(text))
  let hit = 0
  for (const term of q) if (hay.has(term)) hit++
  const gramScore = q.length ? hit / q.length : 0
  // 单字查询（比如「信」）在 2-gram 里永远命中不了，补一个整串包含的兜底
  const rawScore = text.includes(trimmed) ? 0.6 : 0
  return clamp01(Math.max(gramScore, rawScore))
}

/** 用关键词分构造候选，供无模型环境使用。 */
export function keywordCandidates(
  query: string,
  docs: Array<{ sceneId: string; index: number; text: string; castIds?: string[]; placeIds?: string[] }>,
): RecallCandidate[] {
  return docs
    .map((d) => ({
      ...d,
      cosine: keywordScore(query, d.text),
    }))
    .filter((c) => c.cosine > 0)
}
