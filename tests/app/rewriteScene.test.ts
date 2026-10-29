import { describe, expect, it } from 'vitest'
import {
  applyManualEdit,
  compressTarget,
  revertScene,
  rewriteScene,
  type RewriteDeps,
} from '../../src/app/rewriteScene'
import { createMemoryKv } from '../../src/store/kv'
import { createRepo } from '../../src/store/repo'
import { FALLBACK_CONFIG } from '../../src/app/config'
import { DomainError } from '../../src/domain/errors'
import type { RewriteMode } from '../../src/app/rewriteScene'

const LONG = '他推开门，雾从门缝里挤进来，在地板上摊成薄薄一层。柜台后面的人没有抬头，只把茶碗往前推了半寸。'

/** 只实现改写用得到的部分；返回固定文本或抛错。 */
function fakeRewriter(next: string | (() => never)) {
  return {
    async rewrite(req: { mode: RewriteMode }) {
      void req
      if (typeof next === 'function') return next()
      return { text: next }
    },
  }
}

// 改写结果同样受「空正文」门槛约束：必须 ≥30 字
const REWRITTEN =
  '林昭推开门。雾从门缝里挤进来，贴着地板铺开。柜台后的人没抬头，只把茶碗往前推了半寸。'

async function setup(next: string | (() => never) = REWRITTEN) {
  const kv = createMemoryKv()
  const repo = createRepo({ kv, now: () => 1000, rand: () => 0.5 })
  const meta = await repo.createSpace({
    title: '雾港',
    world: {
      name: '雾港',
      era: '民国',
      theme: '真相',
      premise: '旧账',
      oneLine: '旧账',
      rules: [],
      factions: [],
    },
    cast: [{ name: '林昭', role: 'protagonist' }],
    places: [{ name: '同福客栈' }],
    mainGoal: '查清死因',
  })
  const scene = {
    id: 'sc_1',
    spaceId: meta.id,
    index: 0,
    status: 'committed' as const,
    action: { kind: 'free' as const, text: '推门' },
    choices: [],
    placeId: null,
    participants: [],
    summary: null,
    clues: [],
    textChars: LONG.length,
    model: 'test',
    inTok: 0,
    outTok: 0,
    committedAt: 1,
    archivedAt: null,
    patchId: null,
  }
  await repo.saveScene(meta.id, scene, LONG)

  const deps: RewriteDeps = {
    repo,
    rewriter: fakeRewriter(next) as never,
    narrator: null as never,
    // 抽取失败走 catch 分支，正好覆盖"重抽失败不影响正文"
    archivist: {
      async archive() {
        throw new Error('no archivist in test')
      },
    } as never,
    config: FALLBACK_CONFIG,
    now: () => 2000,
    rand: () => 0.5,
  }
  return { repo, meta, scene, deps }
}

describe('compressTarget', () => {
  it('取一半', () => {
    expect(compressTarget(600)).toBe(300)
  })

  it('不低于 150（再低就把一幕压成一句话了）', () => {
    expect(compressTarget(200)).toBe(150)
  })
})

describe('rewriteScene', () => {
  it('改写后正文替换，并留下旧版', async () => {
    const { repo, meta, scene, deps } = await setup()
    const result = await rewriteScene(deps, { spaceId: meta.id, sceneId: scene.id, mode: 'compress' })

    expect(await repo.loadText(meta.id, scene.id)).toBe(result.text)
    expect(await repo.loadTextOld(meta.id, scene.id)).toBe(LONG)
  })

  it('改写返回空时不改原文', async () => {
    const { repo, meta, scene, deps } = await setup('')
    await expect(
      rewriteScene(deps, { spaceId: meta.id, sceneId: scene.id, mode: 'rewrite' }),
    ).rejects.toThrow(DomainError)

    expect(await repo.loadText(meta.id, scene.id)).toBe(LONG)
    expect(await repo.loadTextOld(meta.id, scene.id)).toBeNull()
  })

  it('正文太短时直接拒绝（不需要改写）', async () => {
    const { repo, meta, scene, deps } = await setup()
    await repo.saveScene(meta.id, scene, '太短')
    await expect(
      rewriteScene(deps, { spaceId: meta.id, sceneId: scene.id, mode: 'compress' }),
    ).rejects.toThrow()
  })

  it('抽取失败不影响正文落库', async () => {
    const { repo, meta, scene, deps } = await setup()
    const result = await rewriteScene(deps, { spaceId: meta.id, sceneId: scene.id, mode: 'compress' })
    expect(result.archived).toBe(false)
    expect(await repo.loadText(meta.id, scene.id)).toBe(result.text)
  })
})

describe('applyManualEdit', () => {
  it('手改也存旧版', async () => {
    const { repo, meta, scene, deps } = await setup()
    const next = '林昭推开门。雾从门缝里挤进来，在地板上摊成薄薄一层，柜台后的人没抬头。'
    await applyManualEdit(deps, { spaceId: meta.id, sceneId: scene.id, text: next })
    expect(await repo.loadText(meta.id, scene.id)).toBe(next)
    expect(await repo.loadTextOld(meta.id, scene.id)).toBe(LONG)
  })

  it('太短的编辑被拒绝', async () => {
    const { meta, scene, deps } = await setup()
    await expect(
      applyManualEdit(deps, { spaceId: meta.id, sceneId: scene.id, text: '短' }),
    ).rejects.toThrow()
  })
})

describe('revertScene', () => {
  it('撤销把旧版换回来，且可以再撤一次（两次对调）', async () => {
    const { repo, meta, scene, deps } = await setup()
    const result = await rewriteScene(deps, { spaceId: meta.id, sceneId: scene.id, mode: 'compress' })

    const back = await revertScene(deps, { spaceId: meta.id, sceneId: scene.id })
    expect(back.text).toBe(LONG)
    expect(await repo.loadText(meta.id, scene.id)).toBe(LONG)

    // 再撤一次会换回改写后的版本——两次撤销等于互相抵消，不会一路退回更早
    const again = await revertScene(deps, { spaceId: meta.id, sceneId: scene.id })
    expect(again.text).toBe(result.text)
  })

  it('没有旧版时给出可读错误', async () => {
    const { meta, scene, deps } = await setup()
    await expect(revertScene(deps, { spaceId: meta.id, sceneId: scene.id })).rejects.toThrow()
  })
})
