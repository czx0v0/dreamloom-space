/**
 * 叙述视角的解析。
 *
 * 视角决定「玩家的行动算谁的动作」，不是文风偏好：
 *  - first   ：玩家就是故事里的某个人，行动写成「我」做的事
 *  - third   ：玩家操控某个人物，镜头跟随他
 *  - watcher ：玩家是编排者，不扮演具体人物
 *
 * 单独成文件是因为它可以被单测覆盖，且 prompt 与 UI 需要看到同一份判定结果。
 */

import type { CastMember, Pov } from './types'

export interface ResolvedPov {
  /** 实际生效的视角（可能因缺少主角而降级） */
  pov: Pov
  /** 主角名字，用于写进 prompt；没有则为 null */
  protagName: string | null
  /** first 找不到主角时降级为 third */
  downgraded: boolean
}

export function resolvePov(
  pov: Pov,
  protagId: string | null,
  cast: CastMember[],
): ResolvedPov {
  const protag = protagId
    ? cast.find((c) => c.id === protagId && c.removedAt === null && c.supersededBy === null)
    : undefined
  const protagName = protag?.name ?? null

  // 「我是谁」说不清的时候，第一人称会写出混乱的「我」，不如退回第三人称
  if (pov === 'first' && !protagName) {
    return { pov: 'third', protagName: null, downgraded: true }
  }

  return { pov, protagName, downgraded: false }
}

export const POV_LABEL: Record<Pov, string> = {
  first: '第一人称',
  third: '第三人称',
  watcher: '旁观',
}

export const POV_HINT: Record<Pov, string> = {
  first: '我是故事里的一个人，用「我」叙述',
  third: '镜头跟随主角，第三人称',
  watcher: '我是编排者，不扮演具体人物',
}
