/**
 * 回退：把档案恢复到某一幕结束时的状态。
 *
 * 为什么不是"存档式"回退：
 * 每幕存一份完整 canon 会写放大（20KB × 幕数），所以采用「每 10 幕一份快照 + 重放补丁」：
 * 找到不超过目标幕的最近快照，再把快照之后、目标幕之前的补丁按顺序重放一遍。
 * 补丁是 ref-based 且幂等的，重放不会产生重复实体。
 *
 * 被回退掉的幕不删除，只标 `orphan`：它们不再进上下文，但可以导出，也不影响已有正文。
 */

import { applyPatch } from '../domain/patch'
import { makeId } from '../domain/ids'
import type { CanonSnapshot, CanonState, SpaceMeta } from '../domain/types'
import type { SpaceRepo } from '../store/repo'

export interface RollbackResult {
  restored: boolean
  /** 从哪一份快照起算 */
  fromSnapshot: string | null
  replayed: number
  orphaned: number
  warnings: string[]
}

export async function snapshotCanon(
  repo: SpaceRepo,
  spaceId: string,
  meta: SpaceMeta,
  canon: CanonState,
  sceneIndex: number,
): Promise<void> {
  await repo.saveSnapshot(spaceId, {
    rev: meta.canonRev,
    sceneId: meta.activeSceneId ?? '',
    sceneIndex,
    world: canon.world,
    cast: canon.cast,
    places: canon.places,
    relations: canon.relations,
    facts: canon.facts,
  } satisfies CanonSnapshot)
}

export async function rollbackTo(
  repo: SpaceRepo,
  spaceId: string,
  targetSceneId: string,
  now: number,
): Promise<RollbackResult> {
  const [scenes, patches, meta] = await Promise.all([
    repo.listScenes(spaceId),
    repo.listPatches(spaceId),
    repo.loadMeta(spaceId),
  ])

  const target = scenes.find((s) => s.id === targetSceneId)
  if (!target) {
    return { restored: false, fromSnapshot: null, replayed: 0, orphaned: 0, warnings: ['找不到这一幕'] }
  }
  if (target.status !== 'committed' && target.status !== 'orphan') {
    return {
      restored: false,
      fromSnapshot: null,
      replayed: 0,
      orphaned: 0,
      warnings: ['只能回到已经写完的幕'],
    }
  }

  const snapshot = await repo.latestSnapshotBefore(spaceId, target.index)
  if (!snapshot) {
    return {
      restored: false,
      fromSnapshot: null,
      replayed: 0,
      orphaned: 0,
      warnings: ['没有找到可用的档案快照，无法精确还原'],
    }
  }

  let canon: CanonState = {
    world: snapshot.world,
    cast: snapshot.cast,
    places: snapshot.places,
    relations: snapshot.relations,
    facts: snapshot.facts,
  }

  const patchByScene = new Map(patches.map((p) => [p.sceneId, p]))
  const idGen = (prefix: string) => makeId(prefix, now)
  let replayed = 0

  for (const scene of scenes) {
    if (scene.index <= (snapshot.sceneIndex ?? -1) || scene.index > target.index) continue
    const patch = patchByScene.get(scene.id)
    if (!patch || !patch.ops.length) continue
    const outcome = applyPatch(canon, patch.ops, {
      spaceId,
      sceneId: scene.id,
      now,
      existingClues: [],
      idGen,
    })
    canon = outcome.state
    replayed++
  }

  await repo.saveCanon(spaceId, canon)

  let orphaned = 0
  for (const scene of scenes) {
    if (scene.index > target.index && scene.status !== 'orphan') {
      const text = await repo.loadText(spaceId, scene.id)
      await repo.saveScene(spaceId, { ...scene, status: 'orphan' }, text)
      orphaned++
    }
  }

  await repo.saveMeta(spaceId, {
    ...meta,
    activeSceneId: target.id,
    sceneCount: target.index + 1,
    archiveWatermark: target.id,
    canonRev: meta.canonRev + 1,
  })

  await snapshotCanon(
    repo,
    spaceId,
    { ...meta, canonRev: meta.canonRev + 1, activeSceneId: target.id },
    canon,
    target.index,
  )

  return {
    restored: true,
    fromSnapshot: snapshot.sceneIndex === -1 ? '初始状态' : `第 ${(snapshot.sceneIndex ?? 0) + 1} 幕`,
    replayed,
    orphaned,
    warnings: [],
  }
}
