import { describe, expect, it } from 'vitest'
import { createRepo } from '../../src/store/repo'
import { createMemoryKv } from '../../src/store/kv'
import type { Scene, SpaceBundle } from '../../src/domain/types'

function setup() {
  let t = 1000
  const kv = createMemoryKv()
  const repo = createRepo({ kv, now: () => (t += 10), rand: () => 0.5 })
  return { kv, repo, tick: () => (t += 10) }
}

const WORLD = {
  name: '雾港',
  era: '民国',
  theme: '真相',
  premise: '一桩旧案',
  oneLine: '多雾的港口',
  rules: ['没有警察'],
  factions: ['码头帮'],
}

async function makeSpace(repo: ReturnType<typeof setup>['repo']) {
  return repo.createSpace({
    title: '雾港旧案',
    cover: '🌫️',
    genre: '悬疑',
    world: WORLD,
    cast: [
      { name: '林昭', role: 'protagonist', oneLine: '记者' },
      { name: '掌柜', oneLine: '客栈老板' },
    ],
    places: [{ name: '同福客栈', kind: '客栈' }],
  })
}

function scene(index: number, sp: string, over: Partial<Scene> = {}): Scene {
  return {
    id: `sc_${index}`,
    spaceId: sp,
    index,
    status: 'committed',
    action: { kind: 'free', text: '推门' },
    choices: [],
    placeId: null,
    participants: [],
    summary: `第 ${index} 幕`,
    clues: [],
    textChars: 10,
    model: 'test',
    inTok: 0,
    outTok: 0,
    committedAt: 1,
    archivedAt: null,
    patchId: null,
    ...over,
  }
}

describe('createSpace', () => {
  it('建空间后书架有索引、档案齐全', async () => {
    const { repo } = setup()
    const meta = await makeSpace(repo)

    const list = await repo.listSpaces()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: meta.id, title: '雾港旧案', sceneCount: 0 })

    const canon = await repo.loadCanon(meta.id)
    expect(canon.cast).toHaveLength(2)
    expect(canon.places).toHaveLength(1)
    expect(canon.facts).toEqual([])
    expect(meta.protagId).toBe(canon.cast.find((c) => c.role === 'protagonist')?.id)
  })
})

describe('场景读写', () => {
  it('正文与元数据分行存储，取回一致', async () => {
    const { repo } = setup()
    const meta = await makeSpace(repo)
    const s = scene(0, meta.id)
    await repo.saveScene(meta.id, s, '他推开门。')

    expect(await repo.loadText(meta.id, s.id)).toBe('他推开门。')
    const scenes = await repo.listScenes(meta.id)
    expect(scenes).toHaveLength(1)
    expect(scenes[0].summary).toBe('第 0 幕')
  })

  it('按 index 排序，且同步更新幕数', async () => {
    const { repo } = setup()
    const meta = await makeSpace(repo)
    for (const i of [2, 0, 1]) await repo.saveScene(meta.id, scene(i, meta.id), `正文${i}`)

    const scenes = await repo.listScenes(meta.id)
    expect(scenes.map((s) => s.index)).toEqual([0, 1, 2])

    const reloaded = await repo.loadMeta(meta.id)
    expect(reloaded.sceneCount).toBe(3)
    expect(reloaded.activeSceneId).toBe('sc_1')
  })

  it('aborted 场景不增加幕数', async () => {
    const { repo } = setup()
    const meta = await makeSpace(repo)
    await repo.saveScene(meta.id, scene(0, meta.id, { status: 'aborted' }), '半截')
    const reloaded = await repo.loadMeta(meta.id)
    expect(reloaded.sceneCount).toBe(0)
  })
})

describe('导出与导入', () => {
  it('round-trip 保留档案与正文，且导入为副本', async () => {
    const { repo } = setup()
    const meta = await makeSpace(repo)
    await repo.saveScene(meta.id, scene(0, meta.id), '第一段正文')
    await repo.saveScene(meta.id, scene(1, meta.id), '第二段正文')

    const bundle = await repo.exportBundle(meta.id)
    expect(bundle.format).toBe('dreamloom')
    expect(bundle.scenes).toHaveLength(2)
    expect(bundle.texts['sc_0']).toBe('第一段正文')
    expect(bundle.cast).toHaveLength(2)

    const copy = await repo.importBundle(JSON.parse(JSON.stringify(bundle)) as SpaceBundle)
    expect(copy.id).not.toBe(meta.id)
    expect(copy.title).toContain('副本')

    const copyCanon = await repo.loadCanon(copy.id)
    expect(copyCanon.cast.every((c) => c.spaceId === copy.id)).toBe(true)
    expect(await repo.loadText(copy.id, 'sc_1')).toBe('第二段正文')
    expect((await repo.listSpaces()).length).toBe(2)
  })

  it('导入不覆盖原空间', async () => {
    const { repo } = setup()
    const meta = await makeSpace(repo)
    const bundle = await repo.exportBundle(meta.id)
    await repo.importBundle(bundle)
    const still = await repo.loadMeta(meta.id)
    expect(still.title).toBe('雾港旧案')
  })
})

describe('删除空间', () => {
  it('连带清理所有前缀 key', async () => {
    const { repo, kv } = setup()
    const meta = await makeSpace(repo)
    await repo.saveScene(meta.id, scene(0, meta.id), '正文')

    await repo.deleteSpace(meta.id)

    expect(await repo.listSpaces()).toHaveLength(0)
    const left = Object.keys(kv.dump()).filter((k) => k.includes(meta.id))
    expect(left).toEqual([])
  })
})

describe('人物库', () => {
  it('保存后出现在索引里，且 rev 递增', async () => {
    const { repo } = setup()
    const persona = await repo.savePersona({
      id: 'pe_1',
      v: 1,
      name: '林昭',
      aliases: [],
      appearance: '',
      oneLine: '记者',
      personality: ['冷静'],
      abilities: [],
      voice: '慢',
      backstory: '',
      secrets: [],
      tags: [],
      origin: 'user',
      rev: 1,
      createdAt: 1000,
      updatedAt: 0,
    })
    expect((await repo.listPersonas()).map((p) => p.id)).toEqual(['pe_1'])

    const updated = await repo.savePersona(persona)
    expect(updated.rev).toBeGreaterThan(persona.rev)

    await repo.deletePersona('pe_1')
    expect(await repo.listPersonas()).toHaveLength(0)
  })
})

describe('统计幂等', () => {
  it('重复保存同一幕不会把字数翻倍', async () => {
    const { repo } = setup()
    const meta = await makeSpace(repo)
    const s = scene(0, meta.id)
    await repo.saveScene(meta.id, s, '一二三四五')
    const first = (await repo.loadMeta(meta.id)).stats.chars
    await repo.saveScene(meta.id, { ...s, summary: '补摘要' }, '一二三四五')
    await repo.saveScene(meta.id, { ...s, participants: ['ch_x'] }, '一二三四五')
    const second = (await repo.loadMeta(meta.id)).stats.chars
    expect(second).toBe(first)
    expect((await repo.loadMeta(meta.id)).sceneCount).toBe(1)
  })
})

describe('saveCanon 对账', () => {
  it('不在 canon 里的行会被删除（否则回退后“删不掉人”）', async () => {
    const { repo } = setup()
    const meta = await makeSpace(repo)
    const canon = await repo.loadCanon(meta.id)
    expect(canon.cast).toHaveLength(2)

    await repo.saveCanon(meta.id, { ...canon, cast: [canon.cast[0]] })

    const after = await repo.loadCanon(meta.id)
    expect(after.cast).toHaveLength(1)
    expect(after.cast[0].id).toBe(canon.cast[0].id)
  })

  it('无关空间的实体不受影响', async () => {
    const { repo } = setup()
    const a = await makeSpace(repo)
    const b = await makeSpace(repo)
    const canonA = await repo.loadCanon(a.id)
    await repo.saveCanon(a.id, { ...canonA, cast: [] })
    expect((await repo.loadCanon(b.id)).cast).toHaveLength(2)
  })
})

describe('resolveClues', () => {
  it('收线写回线索所在那一幕，且不改字数统计', async () => {
    const { repo } = setup()
    const meta = await makeSpace(repo)
    const first = scene(0, meta.id, {
      clues: [
        {
          id: 'cl_a',
          kind: 'open-thread',
          known: '掌柜每晚上楼',
          unknown: '掌柜每晚上楼做什么',
          text: '掌柜每晚上楼做什么',
          thread: { kind: 'main', id: null, label: '主线' },
          sceneId: 'sc_0',
          status: 'open',
          resolvedAtSceneId: null,
        },
      ],
    })
    await repo.saveScene(meta.id, first, '雾从港口漫上来，掌柜在擦碗。')
    const before = await repo.loadMeta(meta.id)

    const changed = await repo.resolveClues(meta.id, ['cl_a'], 'sc_9')
    expect(changed).toBe(1)

    const scenes = await repo.listScenes(meta.id)
    expect(scenes[0].clues[0]).toMatchObject({ status: 'resolved', resolvedAtSceneId: 'sc_9' })
    const after = await repo.loadMeta(meta.id)
    expect(after.stats.chars).toBe(before.stats.chars)
    expect(after.sceneCount).toBe(before.sceneCount)
  })

  it('id 不存在时返回 0，不产生写操作', async () => {
    const { repo } = setup()
    const meta = await makeSpace(repo)
    await repo.saveScene(meta.id, scene(0, meta.id), '正文')
    expect(await repo.resolveClues(meta.id, ['cl_nope'], 'sc_9')).toBe(0)
  })
})

describe('expireClues', () => {
  it('悬够 12 幕的线索被放下，之后不再重复处理', async () => {
    const { repo } = setup()
    const meta = await makeSpace(repo)
    await repo.saveScene(
      meta.id,
      scene(0, meta.id, {
        clues: [
          {
            id: 'cl_old',
            kind: 'open-thread',
            known: '掌柜每晚上楼',
            unknown: '他上楼做什么',
            text: '他上楼做什么',
            thread: { kind: 'main', id: null, label: '主线' },
            sceneId: 'sc_0',
            status: 'open',
            resolvedAtSceneId: null,
          },
        ],
      }),
      '正文',
    )

    expect(await repo.expireClues(meta.id, 11, 12)).toBe(0)
    expect(await repo.expireClues(meta.id, 12, 12)).toBe(1)

    const scenes = await repo.listScenes(meta.id)
    expect(scenes[0].clues[0].status).toBe('dropped')
    expect(await repo.expireClues(meta.id, 20, 12)).toBe(0)
  })
})


describe('旧存档归一化', () => {
  it('meta 缺 mode / scheduled / objectives 时补默认值', async () => {
    const kv = createMemoryKv({
      'meta/sp_old': {
        id: 'sp_old',
        v: 1,
        title: '旧空间',
        cover: '📖',
        createdAt: 1,
        updatedAt: 1,
        genre: '悬疑',
        tone: '冷峻',
        pov: 'third',
        protagId: null,
        settings: {},
        hardRules: [],
        mainGoal: '',
        sceneCount: 0,
        canonRev: 0,
        stats: {},
      },
    })
    const repo = createRepo({ kv, now: () => 1 })
    const meta = await repo.loadMeta('sp_old')
    expect(meta.mode).toBe('goal')
    expect(meta.scheduled).toEqual([])
    expect(meta.objectives).toEqual([])
    expect(meta.settings.choiceCount).toBe(4)
    expect(meta.stats.chars).toBe(0)
  })

  it('cast 缺数组字段时补空数组，hidden 从 secrets 推导', async () => {
    const kv = createMemoryKv({
      'cast/sp_old/ch_1': {
        id: 'ch_1',
        spaceId: 'sp_old',
        name: '林昭',
        role: 'protagonist',
        status: 'alive',
        oneLine: '记者',
        secrets: ['他回来不是为了查案'],
      },
    })
    const repo = createRepo({ kv, now: () => 1 })
    const canon = await repo.loadCanon('sp_old')
    expect(canon.cast[0].abilities).toEqual([])
    expect(canon.cast[0].hidden?.[0].text).toBe('他回来不是为了查案')
    expect(canon.cast[0].removedAt).toBeNull()
  })
})

describe('markCluePursued', () => {
  it('标记追问后写入 pursuedAt，且过期时给更长保留期', async () => {
    const { repo } = setup()
    const meta = await makeSpace(repo)
    await repo.saveScene(
      meta.id,
      scene(0, meta.id, {
        clues: [
          {
            id: 'cl_x',
            kind: 'open-thread',
            known: '掌柜每晚上楼',
            unknown: '他上楼做什么',
            text: '他上楼做什么',
            thread: { kind: 'main', id: null, label: '主线' },
            sceneId: 'sc_0',
            status: 'open',
            resolvedAtSceneId: null,
          },
        ],
      }),
      '正文',
    )

    expect(await repo.markCluePursued(meta.id, 'cl_x', 5000)).toBe(true)
    const marked = (await repo.listScenes(meta.id))[0].clues[0]
    expect(marked.pursuedAt).toBe(5000)

    // 普通线索 12 幕就放下；追问过的要到 24 幕
    expect(await repo.expireClues(meta.id, 12, 12)).toBe(0)
    expect(await repo.expireClues(meta.id, 24, 12)).toBe(1)
  })

  it('标记不存在的线索返回 false', async () => {
    const { repo } = setup()
    const meta = await makeSpace(repo)
    expect(await repo.markCluePursued(meta.id, 'cl_none')).toBe(false)
  })
})

describe('人物库出口归一化', () => {
  it('旧索引没有 tags 时补空数组，页面不会再按 undefined 渲染', async () => {
    const kv = createMemoryKv({
      personas: [{ id: 'pe_1', name: '林昭', oneLine: '记者', updatedAt: 10 }],
    })
    const repo = createRepo({ kv, now: () => 1 })
    const list = await repo.listPersonas()
    expect(list).toHaveLength(1)
    expect(list[0].tags).toEqual([])
    expect(list[0].oneLine).toBe('记者')
  })

  it('旧原型缺数组字段时，读取即补齐（不动库）', async () => {
    const kv = createMemoryKv({
      'persona/pe_1': {
        id: 'pe_1',
        v: 1,
        name: '老周',
        oneLine: '',
        createdAt: 1,
        updatedAt: 1,
      },
    })
    const repo = createRepo({ kv, now: () => 1 })
    const p = await repo.loadPersona('pe_1')
    expect(p).toBeDefined()
    expect(p!.personality).toEqual([])
    expect(p!.abilities).toEqual([])
    expect(p!.secrets).toEqual([])
    expect(p!.tags).toEqual([])
    expect(p!.rev).toBe(1)
    // 不写回：再读一次还是原始数据，避免每次打开都触发写
    const raw = await kv.get<{ tags?: unknown }>('persona/pe_1')
    expect(raw!.tags).toBeUndefined()
  })
})
