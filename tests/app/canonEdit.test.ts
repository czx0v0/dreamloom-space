import { describe, expect, it } from 'vitest'
import { acceptMerge, applyCastEdit, dismissMerge, repointScenes } from '../../src/app/canonEdit'
import { advanceScene } from '../../src/app/advanceScene'
import { createSpaceFromTemplate } from '../../src/app/createSpace'
import { FALLBACK_CONFIG } from '../../src/app/config'
import type { ArchivistPort, NarrateEvent, NarratorPort } from '../../src/agents/ports'
import type { MergeProposal, Scene } from '../../src/domain/types'
import { createMemoryKv } from '../../src/store/kv'
import { createRepo } from '../../src/store/repo'
import { TEMPLATES } from '../../src/store/seed'
import { makeCast } from '../helpers'

function scene(over: Partial<Scene> = {}): Scene {
  return {
    id: 'sc_1',
    spaceId: 'sp_1',
    index: 0,
    status: 'committed',
    action: null,
    choices: [],
    placeId: null,
    participants: [],
    summary: null,
    clues: [],
    textChars: 0,
    model: 'test',
    inTok: 0,
    outTok: 0,
    committedAt: 1,
    archivedAt: null,
    patchId: null,
    ...over,
  }
}

describe('applyCastEdit', () => {
  it('改了就锁定该字段', () => {
    const cast = makeCast({ oneLine: '' })
    const next = applyCastEdit(cast, 'oneLine', '查旧案的记者')
    expect(next.oneLine).toBe('查旧案的记者')
    expect(next.locked.oneLine).toBe(true)
  })

  it('voice / goal 可改但不上锁（这两项允许模型后续补充）', () => {
    const cast = makeCast({ voice: '' })
    const next = applyCastEdit(cast, 'voice', '很慢')
    expect(next.voice).toBe('很慢')
    expect(next.locked.oneLine).toBeUndefined()
  })

  it('超长输入被截断到上限', () => {
    const cast = makeCast()
    expect(applyCastEdit(cast, 'oneLine', '字'.repeat(80)).oneLine).toHaveLength(40)
    expect(applyCastEdit(cast, 'voice', '字'.repeat(80)).voice).toHaveLength(30)
  })

  it('值没变时返回原对象（避免无意义的写库）', () => {
    const cast = makeCast({ oneLine: '记者' })
    expect(applyCastEdit(cast, 'oneLine', ' 记者 ')).toBe(cast)
  })
})

describe('repointScenes', () => {
  it('把旧 id 换成新 id 并去重', () => {
    const scenes = [
      scene({ id: 'sc_1', participants: ['ch_a', 'ch_b'] }),
      scene({ id: 'sc_2', participants: ['ch_c'] }),
    ]
    const next = repointScenes(scenes, 'ch_b', 'ch_a')
    expect(next[0].participants).toEqual(['ch_a'])
    expect(next[1]).toBe(scenes[1])
  })

  it('没有命中时返回原数组（不产生多余写入）', () => {
    const scenes = [scene({ participants: ['ch_c'] })]
    expect(repointScenes(scenes, 'ch_x', 'ch_a')).toBe(scenes)
  })
})

// ── 合并确认的端到端 ────────────────────────────────

// 必须 ≥30 字：太短的正文会被空正文拦截拒掉（那是产品规则，不是测试细节）
const SCENE_TEXT =
  '林昭推开门。掌柜抬头看了他一眼，把茶碗往前推了半寸。「你迟到了。」他说，声音比记忆里低一些。窗外的汽笛响了两声。'

function narrator(): NarratorPort {
  return {
    narrate() {
      async function* events(): AsyncGenerator<NarrateEvent> {
        yield { type: 'meta', data: { runId: 'r1', model: 'fake' } }
        yield { type: 'delta', text: SCENE_TEXT }
        yield { type: 'done', data: { finishReason: 'stop', chars: SCENE_TEXT.length, ms: 1, choices: ['甲'] } }
      }
      return { events: events(), abort: () => {} }
    },
  }
}

function archivist(): ArchivistPort {
  return {
    async archive() {
      return {
        summary: '林昭进了客栈。',
        ops: [],
        warnings: [],
        usage: { inTok: 0, outTok: 0 },
        repaired: false,
      }
    },
  }
}

async function setupWithMerge() {
  const kv = createMemoryKv()
  const repo = createRepo({ kv, now: () => Date.now(), rand: () => 0.5 })
  const meta = await createSpaceFromTemplate(repo, TEMPLATES[0])
  await advanceScene(
    { repo, narrator: narrator(), archivist: archivist(), config: FALLBACK_CONFIG, now: () => Date.now(), rand: () => 0.5 },
    { spaceId: meta.id, action: { kind: 'free', text: '推门' } },
  )

  const canon = await repo.loadCanon(meta.id)
  const lin = canon.cast.find((c) => c.name === '林昭')!
  const zhang = canon.cast.find((c) => c.name === '掌柜')!
  const proposal: MergeProposal = {
    id: 'mg_1',
    spaceId: meta.id,
    aId: lin.id,
    bId: zhang.id,
    reason: 'similar-name',
    evidence: '测试',
    confidence: 0.5,
    status: 'pending',
    createdAt: Date.now(),
  }
  await repo.saveMergeProposals(meta.id, [proposal])
  return { repo, meta, proposal, lin, zhang }
}

describe('acceptMerge', () => {
  it('合并档案、重指场景、移除建议', async () => {
    const { repo, meta, proposal, lin, zhang } = await setupWithMerge()
    const result = await acceptMerge(repo, meta.id, proposal, Date.now())

    expect(result.merged).toBe(true)
    expect(result.aliasesMoved).toBeGreaterThan(0)

    const canon = await repo.loadCanon(meta.id)
    const winner = canon.cast.find((c) => c.id === lin.id)!
    const loser = canon.cast.find((c) => c.id === zhang.id)!
    expect(winner.aliases).toContain('掌柜')
    expect(loser.supersededBy).toBe(lin.id)

    const scenes = await repo.listScenes(meta.id)
    expect(scenes[0].participants).toContain(lin.id)
    expect(scenes[0].participants).not.toContain(zhang.id)

    expect(await repo.listMergeProposals(meta.id)).toHaveLength(0)
  })

  it('合并后场景正文不受影响', async () => {
    const { repo, meta, proposal, lin } = await setupWithMerge()
    const before = await repo.listScenes(meta.id)
    await acceptMerge(repo, meta.id, proposal, Date.now())
    expect(await repo.loadText(meta.id, before[0].id)).toBe(SCENE_TEXT)
    expect(lin.name).toBe('林昭')
  })
})

describe('dismissMerge', () => {
  it('忽略只移除建议，不改档案', async () => {
    const { repo, meta, proposal, zhang } = await setupWithMerge()
    await dismissMerge(repo, meta.id, proposal.id)
    expect(await repo.listMergeProposals(meta.id)).toHaveLength(0)
    const canon = await repo.loadCanon(meta.id)
    expect(canon.cast.find((c) => c.id === zhang.id)?.supersededBy).toBeNull()
  })
})
