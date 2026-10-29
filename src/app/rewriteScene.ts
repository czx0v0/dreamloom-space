/**
 * 改写一幕：压缩 / 重写 / 手改 / 撤销。
 *
 * 两条硬约束（见 SPEC §5.10.3）：
 *  1. **改写后必须重抽**。原文变了，`evidence` 就对不上——档案里的线索、事实、
 *     角色线会指向不存在的句子。
 *  2. **只保留一份旧版**。「改坏了想撤回一步」是真实需求，「撤回十步」用快照。
 *
 * 已知限制：重抽会把新的 op 应用到 canon，但**旧 patch 的贡献不会撤回**。
 * 压缩通常不改事实，所以影响很小；但改写幅度大时档案可能残留旧信息。
 * 这是有意的取舍——反向应用旧 patch 需要完整的 op 逆运算，成本远大于收益。
 */

import { DomainError, ERR } from '../domain/errors'
import { makeId } from '../domain/ids'
import type { ArchivistPort, RewritePort } from '../agents/ports'
import type { ClientConfig } from './config'
import type { Clue, Scene } from '../domain/types'
import { archiveScene } from './advanceScene'
import type { SpaceRepo } from '../store/repo'

/** 压缩目标：取原字数的一半，但不低于 150（再低就把一幕压成一句话了）。 */
export function compressTarget(chars: number): number {
  return Math.max(150, Math.round(chars / 2))
}

export type RewriteMode = 'compress' | 'rewrite'

export interface RewriteDeps {
  repo: SpaceRepo
  rewriter: RewritePort
  /** 抽取不用叙事端口，但 archiveScene 的签名要求它 */
  narrator: import('../agents/ports').NarratorPort
  archivist: ArchivistPort
  config: ClientConfig
  now: () => number
  rand: () => number
}

export interface RewriteResult {
  text: string
  /** 改写前的字数 */
  before: number
  /** 改写后的字数 */
  after: number
  /** 档案是否成功重抽 */
  archived: boolean
}

/** 直接写正文（手改）：不调模型，但同样存旧版 + 重抽。 */
export async function applyManualEdit(
  deps: RewriteDeps,
  input: { spaceId: string; sceneId: string; text: string },
): Promise<RewriteResult> {
  const text = input.text.trim()
  if (text.replace(/\s/g, '').length < 30) {
    throw new DomainError(ERR.BAD_REQUEST, '正文太短了，至少写两三句话')
  }
  return persist(deps, input.spaceId, input.sceneId, text)
}

/** 改写：压缩或重写。服务端只给候选，这里负责校验与落库。 */
export async function rewriteScene(
  deps: RewriteDeps,
  input: { spaceId: string; sceneId: string; mode: RewriteMode },
): Promise<RewriteResult> {
  const current = await deps.repo.loadText(input.spaceId, input.sceneId)
  if (!current.trim()) throw new DomainError(ERR.BAD_REQUEST, '这一幕没有正文，没法改写')
  // 太短的段落改写没有价值：服务端也会拒（<30 字），不如在本地就说清楚
  if (current.replace(/\s/g, '').length < 30) {
    throw new DomainError(ERR.BAD_REQUEST, '这一幕太短了，不需要改写')
  }

  const targetChars =
    input.mode === 'compress' ? compressTarget(current.length) : current.length

  const res = await deps.rewriter.rewrite({
    mode: input.mode,
    text: current,
    targetChars,
  })

  const next = res.text.trim()
  // 改写也可能返回空/占位文本，同样要拦住——不然会把好正文换成空
  if (next.replace(/\s/g, '').length < 30) {
    throw new DomainError(ERR.EMPTY_NARRATION, '这次没有改写出内容，原文没有动。')
  }

  return persist(deps, input.spaceId, input.sceneId, next)
}

/** 撤销一步：把旧版换回来。 */
export async function revertScene(
  deps: RewriteDeps,
  input: { spaceId: string; sceneId: string },
): Promise<RewriteResult> {
  const old = await deps.repo.revertText(input.spaceId, input.sceneId)
  if (old === null) throw new DomainError(ERR.BAD_REQUEST, '没有可以撤销的版本')

  const scenes = await deps.repo.listScenes(input.spaceId)
  const scene = scenes.find((s) => s.id === input.sceneId)
  if (scene) {
    await deps.repo.saveScene(input.spaceId, { ...scene, textChars: old.replace(/\s/g, '').length }, old)
  }
  return { text: old, before: 0, after: old.length, archived: false }
}

/** 落库 + 重抽。三个入口共用同一套顺序，避免哪条路径漏了重抽。 */
async function persist(
  deps: RewriteDeps,
  spaceId: string,
  sceneId: string,
  text: string,
): Promise<RewriteResult> {
  const before = (await deps.repo.loadText(spaceId, sceneId)).length

  const [meta, canon, scenes] = await Promise.all([
    deps.repo.loadMeta(spaceId),
    deps.repo.loadCanon(spaceId),
    deps.repo.listScenes(spaceId),
  ])
  const scene = scenes.find((s) => s.id === sceneId)
  if (!scene) throw new DomainError(ERR.BAD_REQUEST, '找不到这一幕')

  // 先存旧版：万一重抽失败，正文至少已经换过来了
  const previous = await deps.repo.loadText(spaceId, sceneId)
  await deps.repo.saveTextOld(spaceId, sceneId, previous)

  const nextScene: Scene = { ...scene, textChars: text.replace(/\s/g, '').length }
  await deps.repo.saveScene(spaceId, nextScene, text)

  const openClues: Clue[] = scenes
    .flatMap((s) => s.clues)
    .filter((c) => c.status === 'open')

  let archived = false
  try {
    const result = await archiveScene(
      {
        repo: deps.repo,
        // archiveScene 的依赖里含 narrator，但抽取路径不会用到它
        narrator: deps.narrator,
        archivist: deps.archivist,
        config: deps.config,
        now: deps.now,
        rand: deps.rand,
      },
      meta,
      canon,
      nextScene,
      text,
      openClues,
    )
    if (result) {
      const updated: Scene = {
        ...nextScene,
        summary: result.summary,
        clues: result.clues,
        patchId: result.patchId,
        archivedAt: deps.now(),
      }
      if (result.placeId) updated.placeId = result.placeId
      await deps.repo.saveScene(spaceId, updated, text)
      archived = true
    }
  } catch {
    // 重抽失败不影响正文：正文已经落库，档案稍后可以手动整理
    archived = false
  }

  return { text, before, after: text.length, archived }
}

/** 供 UI 展示：这一段是不是被改写过的（有旧版就能撤） */
export async function canRevert(
  repo: SpaceRepo,
  spaceId: string,
  sceneId: string,
): Promise<boolean> {
  return (await repo.loadTextOld(spaceId, sceneId)) !== null
}

export function newRunId(now: () => number): string {
  return makeId('rw', now())
}
