/**
 * 收线判定：把"这一幕回答了哪些旧问题"从抽取里拆出来，单独问一次。
 *
 * 为什么不让档案员顺手判断：实测 36 幕里 `resolve-clue` 被调用 0 次——
 * 抽取模型正忙着记新信息，没有余力回头对账；即使 prompt 明确要求，
 * 它也会把"线索更清楚了"当成"问题答了"。判断"答没答"是校对任务，
 * 换个更窄的 prompt、更低的温度，准确率完全不同。
 *
 * 这个模块只做**解析与校验**，不碰网络：模型说什么都要过 evidence 子串校验，
 * 否则它会为了凑一个答案而编原句。
 */

import { normalizeName } from './alias'
import { parseLooseJson } from './jsonrepair'
import type { Clue } from './types'

export interface TriageOutcome {
  /** 被判定已回答的线索 id（按输入顺序，去重） */
  ids: string[]
  /** 给了编号但证据不成立、被丢弃的条数 */
  dropped: number
  /** 这一幕结束时视角人物所在的地点名；无法判定或没移动为 null */
  place: string | null
}

/** 证据太短会到处命中（"他说"能出现在任何一段），低于 4 字一律不认。 */
const MIN_EVIDENCE = 4

export function parseTriage(
  raw: string,
  clues: Clue[],
  sceneText: string,
  knownPlaces: string[] = [],
): TriageOutcome {
  let data: unknown
  try {
    data = parseLooseJson(raw)
  } catch {
    return { ids: [], dropped: 0, place: null }
  }

  const list = (data as { resolved?: unknown })?.resolved
  if (!Array.isArray(list)) return { ids: [], dropped: 0, place: placeOf(data, knownPlaces, sceneText) }

  const haystack = normalizeName(sceneText)
  const ids: string[] = []
  let dropped = 0

  for (const item of list.slice(0, 12)) {
    const n = typeof item === 'number' ? item : Number((item as { n?: unknown })?.n)
    const evidence = typeof item === 'string' ? '' : String((item as { evidence?: unknown })?.evidence ?? '')
    const clue = Number.isInteger(n) && n >= 1 && n <= clues.length ? clues[n - 1] : null
    const needle = normalizeName(evidence)

    if (!clue || needle.length < MIN_EVIDENCE || !haystack.includes(needle)) {
      dropped++
      continue
    }
    if (!ids.includes(clue.id)) ids.push(clue.id)
  }

  return { ids, dropped, place: placeOf(data, knownPlaces, sceneText) }
}

/**
 * 位置判定：只认**已知地点**里的名字，且必须在正文里出现过。
 *
 * 模型很爱写"客栈里""仓库外"这类方位词；直接当地点会造出无数重复条目。
 * 匹配不上就返回 null，沿用上一幕——沿用永远比清空安全。
 */
function placeOf(data: unknown, knownPlaces: string[], sceneText: string): string | null {
  const raw = (data as { place?: unknown })?.place
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (name.length < 2 || /^(null|无|none|-|未移动|原地)$/i.test(name)) return null
  const hit = knownPlaces.find((p) => normalizeName(p) === normalizeName(name))
  // 正文里没出现过的地名不认：模型会顺手把"仓库"写成"三号仓库"，
  // 但如果这一幕根本没说这三个字，就是它在猜。
  if (!hit || !normalizeName(sceneText).includes(normalizeName(hit))) return null
  return hit
}
