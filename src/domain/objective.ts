/**
 * 目标与阶段。
 *
 * 阶段由**推导**得出，不落库、不由模型判断：模型每次说的都不一样，会让节奏漂移。
 * 落库的只有 `endedAt`（结局写过没有），其余都是它的函数。
 */

import type { Objective, SpaceMeta, StoryPhase } from './types'

/** 主目标：第一条 `kind === 'main'` 的。 */
export function mainObjective(meta: Pick<SpaceMeta, 'objectives'>): Objective | null {
  return meta.objectives.find((o) => o.kind === 'main') ?? null
}

export interface ObjectiveProgress {
  total: number
  done: number
  /** 0–1；没有目标时为 0（不是 1，避免"什么都没定"被显示成已完成） */
  ratio: number
  mainDone: boolean
  main: Objective | null
}

export function objectiveProgress(meta: Pick<SpaceMeta, 'objectives'>): ObjectiveProgress {
  const total = meta.objectives.length
  const done = meta.objectives.filter((o) => o.status === 'done').length
  const main = mainObjective(meta)
  return {
    total,
    done,
    ratio: total ? done / total : 0,
    mainDone: main?.status === 'done',
    main,
  }
}

/** 阶段阈值：写在代码里而不是配置里，因为它和 prompt 措辞强耦合。 */
const OPENING_UNTIL = 5
const CLIMAX_FROM = 25

/**
 * 推导当前阶段。
 *
 * 顺序不能换：`closed` 优先于一切；主目标达成即进入 `ending`（不必等幕数）。
 * 幕数只用来给"还没达成"的故事定节奏，它本身不是目标。
 */
export function resolvePhase(
  meta: Pick<SpaceMeta, 'objectives' | 'endedAt' | 'mode'>,
  sceneCount: number,
): StoryPhase {
  if (meta.endedAt) return 'closed'
  // 沙盒模式不施加任何节奏约束，但仍可手动收尾（endedAt 优先于它）
  if (meta.mode === 'free') return 'free'
  if (mainObjective(meta)?.status === 'done') return 'ending'
  if (sceneCount < OPENING_UNTIL) return 'opening'
  if (sceneCount < CLIMAX_FROM) return 'investigation'
  return 'climax'
}

export const PHASE_LABEL: Record<StoryPhase, string> = {
  opening: '开场',
  investigation: '调查',
  climax: '逼近',
  ending: '尾声',
  closed: '已完结',
  free: '自由',
}

/** 每个阶段写进 prompt 的要求。空串表示不加额外要求。 */
export const PHASE_RULE: Record<StoryPhase, string> = {
  opening: '',
  investigation: '本幕必须让读者离答案更近一步：推进一条线索，或完成一个目标的一小步。',
  climax: '已经接近结局。本幕必须直接朝主目标推进一步，不要再开新的支线或新的人物。',
  ending: '主目标已经达成。这一段要开始收束，不要引入新问题。',
  closed: '',
  free: '',
}
