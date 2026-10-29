import { describe, expect, it } from 'vitest'
import { advanceScene } from '../../src/app/advanceScene'
import { FALLBACK_CONFIG } from '../../src/app/config'
import { createSpaceFromTemplate } from '../../src/app/createSpace'
import type { ArchivistPort, NarrateEvent, NarratorPort } from '../../src/agents/ports'
import type { ArchiveResponse } from '../../src/agents/contracts'
import { createMemoryKv } from '../../src/store/kv'
import { createRepo } from '../../src/store/repo'
import { TEMPLATES } from '../../src/store/seed'

const SCENE_TEXT = '林昭推开门。掌柜抬头看了他一眼，把茶碗往前推了半寸。雾从门缝里挤进来。'

function fakeNarrator(text = SCENE_TEXT, choices = ['问下去', '转身走', '沉默']): NarratorPort {
  return {
    narrate() {
      async function* events(): AsyncGenerator<NarrateEvent> {
        yield { type: 'meta', data: { runId: 'r1', model: 'fake' } }
        for (let i = 0; i < text.length; i += 8) {
          yield { type: 'delta', text: text.slice(i, i + 8) }
        }
        yield {
          type: 'done',
          data: { finishReason: 'stop', chars: text.length, ms: 10, choices },
        }
      }
      return { events: events(), abort: () => {} }
    },
  }
}

function fakeArchivist(overrides: Partial<ArchiveResponse> = {}): ArchivistPort {
  return {
    async archive() {
      return {
        summary: '林昭进了客栈，掌柜像是早就知道他会来。',
        ops: [
          {
            op: 'upsert-cast' as const,
            ref: '掌柜',
            evidence: '掌柜抬头看了他一眼',
            confidence: 0.8,
            value: { oneLine: '客栈掌柜' },
          },
          {
            op: 'append-clue' as const,
            kind: 'open-thread' as const,
            known: '掌柜提前备好了茶',
            unknown: '掌柜为什么提前备好了茶',
            evidence: '把茶碗往前推了半寸',
          },
        ],
        warnings: [],
        usage: { inTok: 0, outTok: 0 },
        repaired: false,
        ...overrides,
      }
    },
  }
}

async function setup() {
  const kv = createMemoryKv()
  const repo = createRepo({ kv, now: () => Date.now(), rand: () => 0.5 })
  const meta = await createSpaceFromTemplate(repo, TEMPLATES[0])
  return { repo, meta }
}

type Setup = Awaited<ReturnType<typeof setup>>

const deps = (repo: Setup['repo']) => ({
  repo,
  narrator: fakeNarrator(),
  archivist: fakeArchivist(),
  config: FALLBACK_CONFIG,
  now: () => Date.now(),
  rand: () => 0.5,
})

describe('advanceScene · 正常推进', () => {
  it('提交场景、写入在场人物、应用抽取结果', async () => {
    const { repo, meta } = await setup()
    const stages: string[] = []

    const result = await advanceScene(deps(repo), {
      spaceId: meta.id,
      action: { kind: 'free', text: '推门进去' },
      onStage: (s) => stages.push(s),
    })

    expect(result.scene.status).toBe('committed')
    expect(result.scene.summary).toContain('掌柜')
    expect(result.scene.clues).toHaveLength(1)
    expect(result.archiveStatus).toBe('applied')
    expect(stages).toContain('narrating')
    expect(stages[stages.length - 1]).toBe('idle')

    const canon = await repo.loadCanon(meta.id)
    const zhang = canon.cast.find((c) => c.name === '掌柜')
    expect(zhang).toBeDefined()
    // 已有描述不被覆盖：抽取只填空值（fill-if-empty）
    expect(zhang?.oneLine).toBe('同福客栈的老板，什么都记得')
    expect(canon.cast.filter((c) => c.name === '掌柜')).toHaveLength(1)

    const reloaded = await repo.loadMeta(meta.id)
    expect(reloaded.sceneCount).toBe(1)
    expect(reloaded.canonRev).toBe(1)
    expect(reloaded.archiveWatermark).toBe(result.scene.id)
  })

  it('正文里出现的人进入 participants', async () => {
    const { repo, meta } = await setup()
    const result = await advanceScene(deps(repo), {
      spaceId: meta.id,
      action: { kind: 'free', text: '推门' },
    })
    const canon = await repo.loadCanon(meta.id)
    const lin = canon.cast.find((c) => c.name === '林昭')!
    expect(result.scene.participants).toContain(lin.id)
  })

  it('第二幕能读到上一幕的上下文（不重复建档）', async () => {
    const { repo, meta } = await setup()
    const first = await advanceScene(deps(repo), {
      spaceId: meta.id,
      action: { kind: 'free', text: '推门' },
    })
    const second = await advanceScene(deps(repo), {
      spaceId: meta.id,
      action: { kind: 'option', text: '问下去' },
    })

    expect(second.scene.index).toBe(1)
    const canon = await repo.loadCanon(meta.id)
    expect(canon.cast.filter((c) => c.name === '掌柜')).toHaveLength(1)

    const meta2 = await repo.loadMeta(meta.id)
    expect(meta2.canonRev).toBe(2)
    expect(meta2.archiveWatermark).toBe(second.scene.id)
    expect(meta2.archiveWatermark).not.toBe(first.scene.id)
  })

  it('生成中使用服务端回来的选项', async () => {
    const { repo, meta } = await setup()
    const narrator = fakeNarrator(SCENE_TEXT, ['甲', '乙', '丙'])
    const result = await advanceScene({ ...deps(repo), narrator }, {
      spaceId: meta.id,
      action: { kind: 'free', text: '推门' },
    })
    expect(result.scene.choices.map((c) => c.label)).toEqual(['甲', '乙', '丙'])
  })
})

describe('advanceScene · 失败与中断', () => {
  it('抽取失败不阻塞，但不推进水位', async () => {
    const { repo, meta } = await setup()
    const broken: ArchivistPort = {
      async archive() {
        throw new Error('boom')
      },
    }
    const result = await advanceScene({ ...deps(repo), archivist: broken }, {
      spaceId: meta.id,
      action: { kind: 'free', text: '推门' },
    })

    expect(result.scene.status).toBe('committed')
    expect(result.archiveStatus).toBe('failed')

    const reloaded = await repo.loadMeta(meta.id)
    expect(reloaded.archiveWatermark).toBeNull()
    expect(await repo.loadText(meta.id, result.scene.id)).toContain('林昭')
  })

  it('中断时场景标 aborted，不写摘要也不抽取', async () => {
    const { repo, meta } = await setup()
    const controller = new AbortController()
    controller.abort()

    const result = await advanceScene(deps(repo), {
      spaceId: meta.id,
      action: { kind: 'free', text: '推门' },
      signal: controller.signal,
    })

    expect(result.scene.status).toBe('aborted')
    expect(result.archiveStatus).toBe('skipped')
    expect(result.scene.summary).toBeNull()

    const reloaded = await repo.loadMeta(meta.id)
    expect(reloaded.sceneCount).toBe(0)
    expect(reloaded.archiveWatermark).toBeNull()
  })
})

describe('advanceScene · 空正文必须被拦住', () => {
  it('模型返回空串时不产生新的幕', async () => {
    const { repo, meta } = await setup()
    const before = (await repo.listScenes(meta.id)).length
    const narrator = fakeNarrator('', [])

    await expect(
      advanceScene({ ...deps(repo), narrator }, {
        spaceId: meta.id,
        action: { kind: 'free', text: '推门' },
      }),
    ).rejects.toThrow(/没有写出来|太短/)

    expect((await repo.listScenes(meta.id)).length).toBe(before)
  })

  it('「（继续）」这类占位文本同样被拦住', async () => {
    const { repo, meta } = await setup()
    const narrator = fakeNarrator('（继续）', [])
    await expect(
      advanceScene({ ...deps(repo), narrator }, {
        spaceId: meta.id,
        action: { kind: 'free', text: '推门' },
      }),
    ).rejects.toThrow()
  })

  it('被拦下后不推进抽取水位（下一幕仍能正常推进）', async () => {
    const { repo, meta } = await setup()
    const narrator = fakeNarrator('', [])
    await expect(
      advanceScene({ ...deps(repo), narrator }, {
        spaceId: meta.id,
        action: { kind: 'free', text: '推门' },
      }),
    ).rejects.toThrow()

    expect((await repo.loadMeta(meta.id)).archiveWatermark).toBeNull()
  })
})

describe('advanceScene · 收线判定', () => {
  it('独立判定器说这条答了，旧线索才会被收掉', async () => {
    const { repo, meta } = await setup()
    const first = await advanceScene(deps(repo), {
      spaceId: meta.id,
      action: { kind: 'free', text: '开场' },
    })
    expect(first.scene.clues).toHaveLength(1)

    // 判定器只看正文，返回编号 + 原句；这里直接复用第一幕的正文当证据
    const triage = {
      async triage() {
        return { text: `{"resolved":[{"n":1,"evidence":"掌柜抬头看了他一眼"}]}` }
      },
    }
    await advanceScene({ ...deps(repo), triage }, {
      spaceId: meta.id,
      action: { kind: 'free', text: '继续' },
    })

    const scenes = await repo.listScenes(meta.id)
    expect(scenes[0].clues[0].status).toBe('resolved')
    expect(scenes[0].clues[0].resolvedAtSceneId).toBe(scenes[1].id)
  })

  it('判定器超时/报错不影响这一幕提交', async () => {
    const { repo, meta } = await setup()
    await advanceScene(deps(repo), { spaceId: meta.id, action: { kind: 'free', text: '开场' } })
    const triage = {
      async triage() {
        throw new Error('boom')
      },
    }
    const result = await advanceScene({ ...deps(repo), triage }, {
      spaceId: meta.id,
      action: { kind: 'free', text: '继续' },
    })
    expect(result.scene.status).toBe('committed')
  })
})

describe('advanceScene · 行动判定', () => {
  it('带 attempt 时掷骰，并把结果存进 scene.action', async () => {
    const { repo, meta } = await setup()
    const result = await advanceScene(deps(repo), {
      spaceId: meta.id,
      action: { kind: 'option', text: '闯进去', attempt: 'bold' },
    })
    expect(result.scene.action?.attempt).toBe('bold')
    expect(result.scene.action?.check).toBeDefined()
    expect(typeof result.scene.action?.check?.success).toBe('boolean')
  })

  it('不带 attempt 时没有判定，行为与此前一致', async () => {
    const { repo, meta } = await setup()
    const result = await advanceScene(deps(repo), {
      spaceId: meta.id,
      action: { kind: 'free', text: '看一眼' },
    })
    expect(result.scene.action?.check).toBeUndefined()
  })
})


describe('advanceScene · 选项意图', () => {
  it('服务端回传带标签的选项时，标签被解析而不是留在文案里', async () => {
    const { repo, meta } = await setup()
    const narrator = fakeNarrator(SCENE_TEXT, ['[追问] 问掌柜', '[行动] 上楼', '[观察] 看井'])
    const result = await advanceScene({ ...deps(repo), narrator }, {
      spaceId: meta.id,
      action: { kind: 'free', text: '开场' },
    })
    expect(result.scene.choices.map((c) => c.intent)).toEqual(['追问', '行动', '观察'])
    expect(result.scene.choices[0].label).toBe('问掌柜')
  })
})

describe('advanceScene · 追问的硬要求', () => {
  /** 记录送进模型的 sections，用来断言"要求"有没有写进去 */
  function spyNarrator(text: string = SCENE_TEXT) {
    const box = { json: '' }
    const narrator: NarratorPort = {
      narrate(req) {
        box.json = JSON.stringify(req.sections ?? {})
        async function* events(): AsyncGenerator<NarrateEvent> {
          yield { type: 'meta', data: { runId: 'r1', model: 'fake' } }
          yield { type: 'delta', text }
          yield { type: 'done', data: { finishReason: 'stop', chars: text.length, ms: 1, choices: ['继续'] } }
        }
        return { events: events(), abort: () => {} }
      },
    }
    return { narrator, box }
  }

  async function withOpenClue() {
    const { repo, meta } = await setup()
    await advanceScene(deps(repo), { spaceId: meta.id, action: { kind: 'free', text: '开场' } })
    const first = (await repo.listScenes(meta.id))[0]
    await repo.saveScene(
      meta.id,
      {
        ...first,
        clues: [
          {
            id: 'cl_p',
            kind: 'open-thread',
            known: '信封上没有落款',
            unknown: '这封信是谁送来的',
            text: '这封信是谁送来的',
            thread: { kind: 'main', id: null, label: '主线' },
            sceneId: first.id,
            status: 'open',
            resolvedAtSceneId: null,
          },
        ],
      },
      '正文',
    )
    return { repo, meta }
  }

  it('行动是「追查：X」时，会把"必须正面回答"写进上下文', async () => {
    const { repo, meta } = await withOpenClue()
    const { narrator, box } = spyNarrator()
    await advanceScene({ ...deps(repo), narrator }, {
      spaceId: meta.id,
      action: { kind: 'free', text: '追查：这封信是谁送来的' },
    })
    expect(box.json).toContain('玩家明确在追这条未收问题')
    expect(box.json).toContain('这封信是谁送来的')
  })

  it('普通行动不会凭空出现这条要求', async () => {
    const { repo, meta } = await withOpenClue()
    const { narrator, box } = spyNarrator()
    await advanceScene({ ...deps(repo), narrator }, {
      spaceId: meta.id,
      action: { kind: 'free', text: '看看柜台' },
    })
    expect(box.json).not.toContain('玩家明确在追这条未收问题')
  })
})
