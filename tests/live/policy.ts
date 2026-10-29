/**
 * 模拟玩家策略：把「一个人怎么玩」写成确定性函数。
 *
 * 为什么不能全选第一项：那样测出来的重复率是策略造成的，不是模型造成的。
 * 这里按 60 / 25 / 15 分配「顺主线 / 探索 / 自由行动」，并且用种子随机，
 * 保证同一份报告可以复跑对比。
 */

import { textSimilarity } from '../../src/domain/text'
import type { ActionKind, Choice } from '../../src/domain/types'

export type DecisionWhy = 'follow' | 'explore' | 'free'

export interface Decision {
  kind: ActionKind
  text: string
  why: DecisionWhy
}

export interface PolicyInput {
  index: number
  choices: Choice[]
  mainGoal: string
  rand: () => number
}

/** 自由行动的池子：刻意带「移动 / 追问 / 触碰」三类动词，逼出位置与线索变化。 */
const FREE_ACTIONS = [
  '我绕到屋后看看有没有别的门',
  '我叫住他，问他昨晚到底去了哪儿',
  '我伸手去摸那样东西，看它是不是真的',
  '我走到窗边，听外面的动静',
  '我把话挑明：我知道你在骗我',
  '我什么也不说，先退到墙角看他怎么反应',
  '我翻开手边那本册子，找最近的一页',
  '我把身上剩下的东西摊在桌上',
]

export function createPolicy(seed: number) {
  let state = seed >>> 0
  const rand = () => {
    // mulberry32：够随机，也够确定
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  function decide(input: Pick<PolicyInput, 'index' | 'choices' | 'mainGoal'>): Decision {
    const { choices, mainGoal } = input
    if (!choices.length) {
      return { kind: 'free', text: FREE_ACTIONS[Math.floor(rand() * FREE_ACTIONS.length)], why: 'free' }
    }

    const roll = rand()
    if (roll < 0.6) {
      // 顺主线：跟目标字面最接近的那一项。全都无关时退化为探索，
      // 否则「顺主线」会变成「永远点第一项」。
      const scored = choices
        .map((c) => ({ c, score: textSimilarity(c.label, mainGoal) + (c.intent ? 0.05 : 0) }))
        .sort((a, b) => b.score - a.score)
      if (scored[0].score > 0.05) {
        return { kind: 'option', text: scored[0].c.label, why: 'follow' }
      }
    }

    if (roll < 0.85) {
      const pick = choices[Math.floor(rand() * choices.length)]
      return { kind: 'option', text: pick.label, why: 'explore' }
    }

    return { kind: 'free', text: FREE_ACTIONS[Math.floor(rand() * FREE_ACTIONS.length)], why: 'free' }
  }

  return { decide, rand }
}
