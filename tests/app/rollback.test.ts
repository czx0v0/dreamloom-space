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
  return { repo, meta, ids }
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
    expect(result.orphaned).toBe(2)

    const after = await names(repo, meta.id)
    expect(after).toContain('角色1')
    expect(after).not.toContain('角色2')
    expect(after).not.toContain('角色3')

    const reloaded = await repo.loadMeta(meta.id)
    expect(reloaded.sceneCount).toBe(1)
    expect(reloaded.activeSceneId).toBe(ids[0])
    expect(reloaded.archiveWatermark).toBe(ids[0])
  })

  it('被回退的幕标为 orphan，但正文保留', async () => {
    const { repo, meta, ids } = await setup(3)
    await rollbackTo(repo, meta.id, ids[0], Date.now())

    const scenes = await repo.listScenes(meta.id)
    const later = scenes.filter((s) => s.index > 0)
    expect(later).toHaveLength(2)
    expect(later.every((s) => s.status === 'orphan')).toBe(true)
    expect(await repo.loadText(meta.id, ids[2])).toContain('雾从码头漫上来')
  })

  it('回到最后一幕不会产生 orphan', async () => {
    const { repo, meta, ids } = await setup(3)
    const result = await rollbackTo(repo, meta.id, ids[2], Date.now())
    expect(result.orphaned).toBe(0)
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
