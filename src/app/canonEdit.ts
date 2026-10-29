/**
 * 档案的人工编辑与合并确认。
 *
 * 两条原则：
 *  1. 手工改过的字段立刻 `locked`，抽取不能再覆盖（玩家意志高于模型）
 *  2. 合并确认后要把场景里的 participants 一起重指，否则人物详情页会丢掉合并前的出场记录
 */

import { mergeCast } from '../domain/merge'
import type { CastMember, MergeProposal, Scene } from '../domain/types'
import type { SpaceRepo } from '../store/repo'

export type EditableCastField = 'oneLine' | 'voice' | 'goal' | 'voiceId' | 'gender'

const LIMITS: Record<EditableCastField, number> = {
  oneLine: 40,
  voice: 30,
  goal: 80,
  voiceId: 40,
  gender: 8,
}

/** 只允许改描述性字段；改了就锁定，避免下一幕被模型改回去。 */
export function applyCastEdit(
  cast: CastMember,
  field: EditableCastField,
  value: string,
): CastMember {
  const next = value.trim().slice(0, LIMITS[field])
  if (next === cast[field]) return cast
  return {
    ...cast,
    [field]: next,
    locked: field === 'oneLine' ? { ...cast.locked, oneLine: true } : { ...cast.locked },
  }
}

/** 合并后把场景里的旧 id 换成新 id，并去重。 */
export function repointScenes(scenes: Scene[], loserId: string, winnerId: string): Scene[] {
  let touched = false
  const next = scenes.map((scene) => {
    if (!scene.participants.includes(loserId)) return scene
    touched = true
    const participants = Array.from(
      new Set(scene.participants.map((id) => (id === loserId ? winnerId : id))),
    )
    return { ...scene, participants }
  })
  return touched ? next : scenes
}

export interface AcceptMergeResult {
  merged: boolean
  aliasesMoved: number
  scenesRepointed: number
  warnings: string[]
}

/** 确认一条合并建议：合并档案 → 重指场景 → 保存 → 移除建议。 */
export async function acceptMerge(
  repo: SpaceRepo,
  spaceId: string,
  proposal: MergeProposal,
  now: number,
): Promise<AcceptMergeResult> {
  const [canon, scenes, proposals] = await Promise.all([
    repo.loadCanon(spaceId),
    repo.listScenes(spaceId),
    repo.listMergeProposals(spaceId),
  ])

  const outcome = mergeCast(canon, proposal.aId, proposal.bId, now)
  if (outcome.warnings.some((w) => w.includes('已被合并') || w.includes('不在档案'))) {
    return { merged: false, aliasesMoved: 0, scenesRepointed: 0, warnings: outcome.warnings }
  }

  await repo.saveCanon(spaceId, outcome.state)

  const repointed = repointScenes(scenes, proposal.bId, proposal.aId)
  let count = 0
  for (const scene of repointed) {
    const before = scenes.find((s) => s.id === scene.id)
    if (before && before.participants.join() !== scene.participants.join()) {
      await repo.saveScene(spaceId, scene, await repo.loadText(spaceId, scene.id))
      count++
    }
  }

  await repo.saveMergeProposals(
    spaceId,
    proposals.filter((p) => p.id !== proposal.id),
  )

  return {
    merged: true,
    aliasesMoved: outcome.aliasesMoved,
    scenesRepointed: count,
    warnings: outcome.warnings,
  }
}

/** 忽略一条建议：只从待办里拿掉，不改档案。 */
export async function dismissMerge(
  repo: SpaceRepo,
  spaceId: string,
  proposalId: string,
): Promise<void> {
  const proposals = await repo.listMergeProposals(spaceId)
  await repo.saveMergeProposals(
    spaceId,
    proposals.filter((p) => p.id !== proposalId),
  )
}
