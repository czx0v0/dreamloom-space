import { describe, expect, it } from 'vitest'
import { advanceScene } from '../../src/app/advanceScene'
import { createSpaceFromTemplate } from '../../src/app/createSpace'
import { rollbackTo } from '../../src/app/rollback'
import { FALLBACK_CONFIG } from '../../src/app/config'
import type { ArchivistPort, NarrateEvent, NarratorPort } from '../../src/agents/ports'
import type { SpaceRepo } from '../../src/store/repo'
import { createMemoryKv } from '../../src/store/kv'
import { createRepo } from '../../src/store/repo'
import { TEMPLATES } from '../../src/store/seed'

/** 每幕文本不同，避免触发"重复重写"干扰计数 */
function narrator(): NarratorPort {
  let n = 0
  return {
    narrate() {
      n += 1
      const text = `第${n}次的雾从码头漫上来，林昭把伞收起来，靠在门框上。掌柜抬头看了他一眼，没有作声。`
      async function* events(): AsyncGenerator<NarrateEvent> {
        yield { type: 'meta', data: { runId: `r${n}`, model: 'fake' } }
        yield { type: 'delta', text }
        yield { type: 'done', data: { finishReason: 'stop', chars: text.length, ms: 1, choices: ['继续'] } }
      }
      return { events: events(), abort: () => {} }
    },
  }
}

/** 每幕新增一个人物，便于验证档案是否被正确回退 */
function archivist(): ArchivistPort {
  let n = 0
  return {
    async archive() {
      n += 1
      return {
        summary: `第 ${n} 幕的摘要`,
        ops: [
          {
            op: 'upsert-cast' as const,
            ref: `角色${n}`,
            evidence: '雾',
            value: { oneLine: `第 ${n} 幕出现的人` },
          },
        ],
        warnings: [],
        usage: { inTok: 0, outTok: 0 },
        repaired: false,
      }
    },
  }
}

async function setup(count: number) {
  const kv = createMemoryKv()
  const repo = createRepo({ kv, now: () => Date.now(), rand: () => 0.5 })
  const meta = await createSpaceFromTemplate(repo, TEMPLATES[0])
  const deps = {
    repo,
    narrator: narrator(),
    archivist: archivist(),
    config: FALLBACK_CONFIG,
    now: () => Date.now(),
    rand: () => 0.5,
  }
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const r = await advanceScene(deps, { spaceId: meta.id, action: { kind: 'free', text: `行动${i}` } })
    ids.push(r.scene.id)
  }
  return { repo, meta, ids, deps }
}

async function names(repo: SpaceRepo, spaceId: string): Promise<string[]> {
  const canon = await repo.loadCanon(spaceId)
  return canon.cast.map((c) => c.name)
}

describe('rollbackTo', () => {
  it('回到第一幕后，后面的档案改动被还原', async () => {
    const { repo, meta, ids } = await setup(3)
    expect(await names(repo, meta.id)).toEqual(
      expect.arrayContaining(['角色1', '角色2', '角色3']),
    )

    const result = await rollbackTo(repo, meta.id, ids[0], Date.now())
    expect(result.restored).toBe(true)
    expect(result.replayed).toBe(1)
    expect(result.deleted).toBe(2)

    const after = await names(repo, meta.id)
    expect(after).toContain('角色1')
    expect(after).not.toContain('角色2')
    expect(after).not.toContain('角色3')

    const reloaded = await repo.loadMeta(meta.id)
    expect(reloaded.sceneCount).toBe(1)
    expect(reloaded.activeSceneId).toBe(ids[0])
    expect(reloaded.archiveWatermark).toBe(ids[0])
  })

  it('被回退的幕被删除，正文也不再占位', async () => {
    const { repo, meta, ids } = await setup(3)
    await rollbackTo(repo, meta.id, ids[0], Date.now())

    const scenes = await repo.listScenes(meta.id)
    expect(scenes).toHaveLength(1)
    expect(scenes[0].index).toBe(0)
    expect(await repo.loadText(meta.id, ids[2])).toBe('')
  })

  it('回退后继续写，新幕从回退点的下一幕开始编号', async () => {
    const { repo, meta, ids } = await setup(5)
    await rollbackTo(repo, meta.id, ids[0], Date.now())
    const scenes = await repo.listScenes(meta.id)
    expect(scenes).toHaveLength(1)
    // 下一幕 = 已有幕数 1 → index 1（界面显示第 2 幕），不会跳回第 6 幕
    expect(Math.max(...scenes.map((s) => s.index)) + 1).toBe(1)
  })

  it('回到最后一幕不会产生 orphan', async () => {
    const { repo, meta, ids } = await setup(3)
    const result = await rollbackTo(repo, meta.id, ids[2], Date.now())
    expect(result.deleted).toBe(0)
    const scenes = await repo.listScenes(meta.id)
    expect(scenes.every((s) => s.status === 'committed')).toBe(true)
  })

  it('找不到幕时给出可读原因而不是抛错', async () => {
    const { repo, meta } = await setup(1)
    const result = await rollbackTo(repo, meta.id, 'sc_not_exist', Date.now())
    expect(result.restored).toBe(false)
    expect(result.warnings.join()).toContain('找不到')
  })

  it('回退后再推进，幕序接着当前而不是叠加', async () => {
    const { repo, meta, ids } = await setup(3)
    await rollbackTo(repo, meta.id, ids[0], Date.now())

    const deps = {
      repo,
      narrator: narrator(),
      archivist: archivist(),
      config: FALLBACK_CONFIG,
      now: () => Date.now(),
      rand: () => 0.5,
    }
    const next = await advanceScene(deps, { spaceId: meta.id, action: { kind: 'free', text: '换条路' } })
    expect(next.scene.index).toBe(1)
  })
})

describe('旧版 orphan 清理', () => {
  it('遗留 orphan 占着编号时，继续写不会跳号', async () => {
    const { repo, meta, ids } = await setup(3)
    // 模拟旧版回退：只标 orphan，不删除
    for (const id of ids.slice(1)) {
      const scene = (await repo.listScenes(meta.id)).find((s) => s.id === id)!
      await repo.saveScene(meta.id, { ...scene, status: 'orphan' }, `旧正文 ${scene.index}`)
    }

    const result = await advanceScene(
      {
        repo,
        narrator: narrator(),
        archivist: archivist(),
        config: FALLBACK_CONFIG,
        now: () => Date.now(),
        rand: () => 0.5,
      },
      { spaceId: meta.id, action: { kind: 'free', text: '继续' } },
    )

    // 只剩第 1 幕，新幕就该是 index 1（界面第 2 幕），不是第 4 幕
    expect(result.scene.index).toBe(1)
    const scenes = await repo.listScenes(meta.id)
    expect(scenes.map((s) => s.index)).toEqual([0, 1])
    expect((await repo.loadMeta(meta.id)).sceneCount).toBe(2)
  })
})

describe('存档导入后继续', () => {
  it('导出 → 导入 → 还能接着写，编号不跳，快照可用', async () => {
    const { repo, meta } = await setup(3)
    const bundle = await repo.exportBundle(meta.id)
    const copy = await repo.importBundle(bundle)

    const scenes = await repo.listScenes(copy.id)
    expect(scenes).toHaveLength(3)

    const result = await advanceScene(
      {
        repo,
        narrator: narrator(),
        archivist: archivist(),
        config: FALLBACK_CONFIG,
        now: () => Date.now(),
        rand: () => 0.5,
      },
      { spaceId: copy.id, action: { kind: 'free', text: '继续' } },
    )
    expect(result.scene.index).toBe(3)
    expect(await repo.loadText(copy.id, scenes[0].id)).toContain('雾从码头漫上来')
    // 快照随存档带过来，导入的副本也能回退
    expect(await repo.latestSnapshotBefore(copy.id, 0)).toBeDefined()
  })
})

describe('回退后立刻继续写（用户实测：2 幕回退到 1 幕，下一幕应是第 2 幕）', () => {
  it('3 幕回退到第 1 幕，继续写出来的是第 2 幕，旧幕彻底消失', async () => {
    const { repo, meta, ids, deps } = await setup(3)
    const result = await rollbackTo(repo, meta.id, ids[0], Date.now())
    expect(result.deleted).toBe(2)

    const afterRollback = await repo.listScenes(meta.id)
    expect(afterRollback).toHaveLength(1)

    const next = await advanceScene(deps, { spaceId: meta.id, action: { kind: 'free', text: '继续' } })
    expect(next.scene.index).toBe(1)
    expect((await repo.listScenes(meta.id)).map((s) => s.index)).toEqual([0, 1])
    expect((await repo.loadMeta(meta.id)).sceneCount).toBe(2)
  })
})

describe('幕号取最大值 +1（防旧数据空洞/重复）', () => {
  it('即使存在重复索引，新幕也不会撞号', async () => {
    const { repo, meta, ids, deps } = await setup(2)
    // 造一个"重复索引"的脏数据：把第 2 幕改成和第 1 幕同一个 index
    const scenes = await repo.listScenes(meta.id)
    const second = scenes.find((s) => s.id === ids[1])!
    await repo.saveScene(meta.id, { ...second, index: 0 }, '脏数据')

    const next = await advanceScene(deps, { spaceId: meta.id, action: { kind: 'free', text: '继续' } })
    expect(next.scene.index).toBe(1)
  })
})
