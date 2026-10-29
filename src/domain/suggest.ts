/**
 * 辅助生成的解析：模型给的建议只当**草稿**，一律要过长度与去重。
 *
 * 为什么不让 UI 直接吃原始 JSON：模型经常包一层 `{items:[...]}`、偶尔返回单个字符串、
 * 偶尔在建议里塞解释。这里统一收敛成 string[]，页面只负责展示与删除。
 */

import { normalizeName } from './alias'
import { parseLooseJson } from './jsonrepair'

export type SuggestKind = 'events' | 'hidden'

export interface SuggestContext {
  world: string
  goal: string
  cast: string[]
  recent: string[]
}

export function parseSuggestions(raw: string, max = 3): string[] {
  let data: unknown = null
  try {
    data = parseLooseJson(raw)
  } catch {
    data = null
  }
  if (!data) {
    // `parseLooseJson` 找的是对象；模型偶尔直接返回数组，这里补一条直读路径
    const text = String(raw ?? '')
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim()
    try {
      data = JSON.parse(text)
    } catch {
      return []
    }
  }

  let source: unknown = Array.isArray(data)
    ? data
    : ((data as { items?: unknown; suggestions?: unknown })?.items ??
      (data as { suggestions?: unknown })?.suggestions)

  if (!Array.isArray(source)) {
    // 再试一次直读：`parseLooseJson` 对裸数组会退回空对象，不能只看它的结果
    const text = String(raw ?? '')
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim()
    try {
      const direct = JSON.parse(text)
      if (Array.isArray(direct)) source = direct
    } catch {
      // 保持 source 非数组，下面统一返回空
    }
  }

  if (!Array.isArray(source)) return []

  const out: string[] = []
  const seen = new Set<string>()
  for (const item of source) {
    const text =
      typeof item === 'string'
        ? item
        : typeof (item as { text?: unknown })?.text === 'string'
          ? ((item as { text: string }).text)
          : ''
    const clean = text.trim().replace(/^[-*\d.、\s]+/, '').slice(0, 60)
    if (clean.length < 4) continue
    const key = normalizeName(clean)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(clean)
    if (out.length >= max) break
  }
  return out
}
