/**
 * 行动判定：稳妥 / 冒险两档，掷一次骰子决定成败，再把结果交给叙事去写。
 *
 * 为什么判定放在代码里而不是让模型"自己看着办"：
 * 模型写"你成功了"永远比写"你失败了"顺手，于是每个行动都成功，紧张感归零。
 * 代码先定成败，模型只负责把这个结果写得像那么回事。
 *
 * 判定不看具体技能树，只看三件事：姿态、主角登记过的能力数、身边有几个人。
 * 这不是跑团，不需要精确；它要的是"冒险确实更容易翻车"这件事被玩家感知到。
 */

import type { ActionCheck, CheckAttempt } from './types'

export interface CheckInput {
  attempt: CheckAttempt
  /** 主角的能力条目（`CastMember.abilities`），有就加成 */
  abilities: string[]
  /** 在场的其他人数量，最多算 3 个 */
  support: number
  rand: () => number
}

const BASE: Record<CheckAttempt, number> = { safe: 0.86, bold: 0.56 }

export function rollCheck(input: CheckInput): ActionCheck {
  const { attempt, rand } = input
  const abilityBonus = Math.min(0.12, input.abilities.length * 0.04)
  const supportBonus = Math.min(0.1, Math.max(0, input.support) * 0.04)
  const chance = clamp(BASE[attempt] + abilityBonus + supportBonus, 0.2, 0.95)
  const success = rand() < chance
  return {
    attempt,
    success,
    chance: Math.round(chance * 100) / 100,
    reason: reasonOf(attempt, success, input.abilities, input.support),
  }
}

function reasonOf(
  attempt: CheckAttempt,
  success: boolean,
  abilities: string[],
  support: number,
): string {
  const edge = abilities.length ? `靠的是「${abilities[0]}」` : support > 0 ? '身边有人搭手' : '全凭运气'
  if (attempt === 'safe') {
    return success ? `按部就班，${edge}` : `稳着来也出了岔子，${edge}`
  }
  return success ? `赌赢了，${edge}` : `赌输了，${edge}没能兜住`
}

/**
 * 给叙事的判定指令。措辞决定模型怎么写，所以三种结果的写法要分开写死：
 * - 失败不许写成"惊险成功"；
 * - 冒险成功必须有代价，否则冒险没有风险感；
 * - 稳妥成功不许额外加戏，不然稳妥就失去意义。
 */
export function checkDirective(check: ActionCheck): string {
  const pct = Math.round(check.chance * 10)
  if (check.attempt === 'safe') {
    return check.success
      ? `【判定】稳妥 · 成功（成算约 ${pct} 成）。照常推进，不要额外制造意外。`
      : `【判定】稳妥 · 失败（成算约 ${pct} 成）。出一个小岔子：耽误了时间、被人看见、或丢了点东西，但不致命。`
  }
  return check.success
    ? `【判定】冒险 · 成功，但有代价（成算约 ${pct} 成）。写"勉强办成"：办成了，同时付出可见的代价（受伤、暴露、欠人情、损坏物件）。`
    : `【判定】冒险 · 失败（成算约 ${pct} 成）。让失败真的发生：目标没达成，并且当场产生后果。不要写成险胜。`
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}
