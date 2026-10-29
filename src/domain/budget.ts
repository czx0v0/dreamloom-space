/**
 * 上下文预算装配。
 *
 * 真实瓶颈不是窗口大小，是注意力预算：把最近一幕全文 + 全部档案塞进 128k，
 * 铁律与大纲会被稀释到中段（lost in the middle），第 20 幕开始 OOC。
 * 所以这里有一张显式的、可测的分配表和一个固定的裁剪顺序。
 */

export interface BudgetConfig {
  /** 内容分区可用总额（已扣除服务端 prompt 模板开销） */
  contentBudget: number
  /** 每个分区的字符上限 */
  sections: Record<string, number>
  /** 裁剪顺序，从左往右先砍 */
  trimOrder: string[]
  /** 永不被丢弃的分区 */
  pinned: string[]
}

export interface PackResult {
  sections: Record<string, string>
  dropped: string[]
  truncated: string[]
  usedChars: number
  ok: boolean
}

export function packSections(
  input: Record<string, string | undefined | null>,
  cfg: BudgetConfig,
): PackResult {
  const out: Record<string, string> = {}
  const truncated: string[] = []
  const pinned = new Set(cfg.pinned)

  for (const [key, raw] of Object.entries(input)) {
    const value = (raw ?? '').trim()
    if (!value) continue
    const limit = cfg.sections[key]
    if (limit && value.length > limit) {
      out[key] = value.slice(0, limit)
      truncated.push(key)
    } else {
      out[key] = value
    }
  }

  const sum = () => Object.values(out).reduce((n, s) => n + s.length, 0)
  let used = sum()
  const dropped: string[] = []

  for (const key of cfg.trimOrder) {
    if (used <= cfg.contentBudget) break
    if (pinned.has(key)) continue
    const v = out[key]
    if (!v) continue
    used -= v.length
    delete out[key]
    dropped.push(key)
  }

  // 兜底：裁剪顺序走完仍超预算（例如配置表本身不合理），硬截最长的非 pinned 分区
  if (used > cfg.contentBudget) {
    while (used > cfg.contentBudget) {
      let longestKey = ''
      let longestLen = 0
      for (const [key, v] of Object.entries(out)) {
        if (pinned.has(key)) continue
        if (v.length > longestLen) {
          longestLen = v.length
          longestKey = key
        }
      }
      if (!longestKey) break
      const keep = Math.max(0, longestLen - (used - cfg.contentBudget))
      if (keep <= 0) {
        used -= longestLen
        delete out[longestKey]
        if (!dropped.includes(longestKey)) dropped.push(longestKey)
      } else {
        out[longestKey] = out[longestKey].slice(0, keep)
        if (!truncated.includes(longestKey)) truncated.push(longestKey)
        used -= longestLen - keep
      }
    }
  }

  return {
    sections: out,
    dropped,
    truncated,
    usedChars: sum(),
    ok: sum() <= cfg.contentBudget,
  }
}

/** 粗略的中文字符 → token 估算（保守按 1:1）。 */
export function estimateTokens(chars: number): number {
  return chars
}

export interface CharPresetMap {
  [key: string]: { min: number; max: number }
}

export function resolveCharRange(
  presets: CharPresetMap,
  preset: string,
  fallback: { min: number; max: number },
): { min: number; max: number } {
  const found = presets[preset]
  if (!found) return fallback
  const min = Math.max(80, Math.round(found.min))
  const max = Math.max(min + 20, Math.round(found.max))
  return { min, max }
}
