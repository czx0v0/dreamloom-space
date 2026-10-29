import { describe, expect, it } from 'vitest'
import { applyPatch, type ApplyContext } from '../../src/domain/patch'
import type { Clue, PatchOp } from '../../src/domain/types'
import { idGenFactory, makeCast, makePlace, makeState } from '../helpers'

function ctx(over: Partial<ApplyContext> = {}): ApplyContext {
  return {
    spaceId: 'sp_1',
    sceneId: 'sc_2',
    now: 1000,
    existingClues: [],
    idGen: idGenFactory(),
    ...over,
  }
}

describe('applyPatch · 新建', () => {
  it('新人物按 ref 创建并记录首次出场', () => {
    const ops: PatchOp[] = [
      {
        op: 'upsert-cast',
        ref: '掌柜',
        evidence: '掌柜说',
        confidence: 0.8,
        value: { oneLine: '同福客栈掌柜', voice: '慢条斯理' },
      },
    ]
    const out = applyPatch(makeState(), ops, ctx())
    expect(out.state.cast).toHaveLength(1)
    expect(out.state.cast[0]).toMatchObject({
      name: '掌柜',
      oneLine: '同福客栈掌柜',
      firstSeenSceneId: 'sc_2',
      status: 'alive',
      origin: 'extract',
    })
  })

  it('同一 patch 连应用两次结果完全一致（幂等）', () => {
    const ops: PatchOp[] = [
      { op: 'upsert-cast', ref: '掌柜', evidence: '掌柜说', value: { oneLine: '掌柜' } },
      { op: 'upsert-place', ref: '同福客栈', evidence: '客栈', value: { oneLine: '临街' } },
      { op: 'append-clue', kind: 'open-thread', text: '雾里的汽笛', evidence: '汽笛' },
    ]
    const first = applyPatch(makeState(), ops, ctx())
    const second = applyPatch(first.state, ops, ctx({ existingClues: first.clues }))
    expect(second.state).toEqual(first.state)
    expect(second.clues).toEqual(first.clues)
  })
})

describe('applyPatch · 合并', () => {
  it('描述性字段只填空值，不覆盖已有内容', () => {
    const existing = makeCast({ name: '林昭', oneLine: '最初的设定' })
    const out = applyPatch(
      makeState({ cast: [existing] }),
      [{ op: 'upsert-cast', ref: '林昭', evidence: 'x', value: { oneLine: '新的描述' } }],
      ctx(),
    )
    expect(out.state.cast[0].oneLine).toBe('最初的设定')
  })

  it('状态可以更新，并记录变化的幕', () => {
    const existing = makeCast({ name: '林昭', status: 'alive' })
    const out = applyPatch(
      makeState({ cast: [existing] }),
      [{ op: 'upsert-cast', ref: '林昭', evidence: 'x', value: { status: 'dead' } }],
      ctx(),
    )
    expect(out.state.cast[0].status).toBe('dead')
    expect(out.state.cast[0].statusChangedSceneId).toBe('sc_2')
  })

  it('dead 不能复活（状态单调门）', () => {
    const existing = makeCast({ name: '林昭', status: 'dead' })
    const out = applyPatch(
      makeState({ cast: [existing] }),
      [{ op: 'upsert-cast', ref: '林昭', evidence: 'x', value: { status: 'alive' } }],
      ctx(),
    )
    expect(out.state.cast[0].status).toBe('dead')
    expect(out.report[0]).toMatchObject({ result: 'rejected', reason: 'dead-cannot-revive' })
  })

  it('unknown 可以变为 alive', () => {
    const existing = makeCast({ name: '林昭', status: 'unknown' })
    const out = applyPatch(
      makeState({ cast: [existing] }),
      [{ op: 'upsert-cast', ref: '林昭', evidence: 'x', value: { status: 'alive' } }],
      ctx(),
    )
    expect(out.state.cast[0].status).toBe('alive')
  })

  it('玩家锁定的状态不被覆盖', () => {
    const existing = makeCast({ name: '林昭', status: 'alive', locked: { status: true } })
    const out = applyPatch(
      makeState({ cast: [existing] }),
      [{ op: 'upsert-cast', ref: '林昭', evidence: 'x', value: { status: 'dead' } }],
      ctx(),
    )
    expect(out.state.cast[0].status).toBe('alive')
    expect(out.report[0]).toMatchObject({ result: 'rejected', reason: 'locked-by-user' })
  })

  it('新名字不改 name，只追加 alias', () => {
    const existing = makeCast({ name: '林昭' })
    const out = applyPatch(
      makeState({ cast: [existing] }),
      [{ op: 'upsert-cast', ref: '林昭', evidence: 'x', value: { name: '林老板' } }],
      ctx(),
    )
    expect(out.state.cast[0].name).toBe('林昭')
    expect(out.state.cast[0].aliases).toContain('林老板')
  })

  it('别名命中不新建实体', () => {
    const existing = makeCast({ name: '林昭', aliases: ['林老板'] })
    const out = applyPatch(
      makeState({ cast: [existing] }),
      [{ op: 'upsert-cast', ref: '林老板', evidence: 'x', value: { voice: '沙哑' } }],
      ctx(),
    )
    expect(out.state.cast).toHaveLength(1)
    expect(out.state.cast[0].voice).toBe('沙哑')
  })

  it('相似名不自动合并，只给出提示', () => {
    const existing = makeCast({ name: '林昭昭' })
    const out = applyPatch(
      makeState({ cast: [existing] }),
      [{ op: 'upsert-cast', ref: '林昭召', evidence: 'x', value: { voice: '沙哑' } }],
      ctx(),
    )
    expect(out.state.cast).toHaveLength(2)
    expect(out.warnings.join()).toContain('名字相近')
  })
})

describe('applyPatch · 地点与关系', () => {
  it('地点货架去重累加', () => {
    const place = makePlace({ name: '杂货铺', inventory: ['火柴'] })
    const out = applyPatch(
      makeState({ places: [place] }),
      [{ op: 'upsert-place', ref: '杂货铺', evidence: 'x', value: { inventory: ['火柴', '煤油'] } }],
      ctx(),
    )
    expect(out.state.places[0].inventory).toEqual(['火柴', '煤油'])
  })

  it('关系以 edgeKey 幂等，强度取 max', () => {
    const a = makeCast({ name: '林昭' })
    const b = makeCast({ name: '掌柜' })
    const state = makeState({ cast: [a, b] })
    const [idA, idB] = [a.id, b.id].sort()

    const first = applyPatch(
      state,
      [{ op: 'upsert-relation', a: '林昭', b: '掌柜', kind: 'enemy', strength: 2, evidence: 'x' }],
      ctx(),
    )
    expect(first.state.relations).toHaveLength(1)
    expect(first.state.relations[0].edgeKey).toBe(`${idA}|${idB}|enemy`)

    const second = applyPatch(
      first.state,
      [{ op: 'upsert-relation', a: '掌柜', b: '林昭', kind: 'enemy', strength: 4, evidence: 'x' }],
      ctx(),
    )
    expect(second.state.relations).toHaveLength(1)
    expect(second.state.relations[0].strength).toBe(4)

    const third = applyPatch(
      second.state,
      [{ op: 'upsert-relation', a: '林昭', b: '掌柜', kind: 'enemy', strength: 1, evidence: 'x' }],
      ctx(),
    )
    expect(third.state.relations[0].strength).toBe(4)
  })

  it('关系一端不在人物表时跳过', () => {
    const a = makeCast({ name: '林昭' })
    const out = applyPatch(
      makeState({ cast: [a] }),
      [{ op: 'upsert-relation', a: '林昭', b: '不存在的人', kind: 'ally', evidence: 'x' }],
      ctx(),
    )
    expect(out.state.relations).toHaveLength(0)
    expect(out.report[0]).toMatchObject({ result: 'skipped', reason: 'unknown-entity' })
  })
})

describe('applyPatch · 线索与软删', () => {
  it('线索按文本去重', () => {
    const out = applyPatch(
      makeState(),
      [
        { op: 'append-clue', kind: 'open-thread', known: '雾里有汽笛声', unknown: '谁在雾里拉汽笛', evidence: 'x' },
        { op: 'append-clue', kind: 'open-thread', known: '雾里有汽笛声。', unknown: '谁在雾里拉汽笛', evidence: 'x' },
      ],
      ctx(),
    )
    expect(out.clues).toHaveLength(1)
  })

  it('tombstone 只做软删，不物理移除', () => {
    const existing = makeCast({ name: '林昭' })
    const out = applyPatch(
      makeState({ cast: [existing] }),
      [{ op: 'tombstone', entity: 'cast', ref: '林昭', reason: '离场', evidence: 'x' }],
      ctx(),
    )
    expect(out.state.cast).toHaveLength(1)
    expect(out.state.cast[0].removedAt).toBe(1000)
    expect(out.state.cast[0].status).toBe('unknown')
  })
})

describe('append-clue · 线索归属', () => {
  const state = () =>
    makeState({
      cast: [makeCast({ id: 'ch_1', name: '林昭', aliases: ['林记者'] })],
      places: [makePlace({ id: 'pl_1', name: '同福客栈' })],
    })

  const apply = (thread?: string) =>
    applyPatch(
      state(),
      [
        {
          op: 'append-clue',
          kind: 'open-thread',
          known: '信封上没有落款',
          unknown: '信是谁寄的',
          thread,
          evidence: 'x',
        },
      ],
      ctx(),
    ).clues[0]

  it('缺省归主线（一条线索没有归属，比归错更糟）', () => {
    expect(apply()).toMatchObject({ thread: { kind: 'main', id: null, label: '主线' } })
  })

  it('写「主线」也归主线', () => {
    expect(apply('主线').thread.kind).toBe('main')
  })

  it('命中角色名：挂到该角色，label 用权威名', () => {
    expect(apply('林昭').thread).toEqual({ kind: 'cast', id: 'ch_1', label: '林昭' })
  })

  it('别名同样能解析', () => {
    expect(apply('林记者').thread).toEqual({ kind: 'cast', id: 'ch_1', label: '林昭' })
  })

  it('命中地点', () => {
    expect(apply('同福客栈').thread).toEqual({ kind: 'place', id: 'pl_1', label: '同福客栈' })
  })

  it('认不出来的称呼归主线，不丢线索', () => {
    expect(apply('某个还没出场的人').thread.kind).toBe('main')
  })
})

describe('move-to · 位置', () => {
  const state = () =>
    makeState({
      cast: [
        makeCast({ id: 'ch_1', name: '林昭' }),
        makeCast({ id: 'ch_2', name: '阿棠' }),
      ],
      places: [makePlace({ id: 'pl_1', name: '同福客栈' })],
    })

  it('移到已登记的地点：返回该地点 id 并更新移动者的位置', () => {
    const out = applyPatch(
      state(),
      [{ op: 'move-to', ref: '同福客栈', who: '林昭', evidence: 'x' }],
      ctx({ protagId: 'ch_1' }),
    )
    expect(out.placeId).toBe('pl_1')
    expect(out.state.cast.find((c) => c.id === 'ch_1')?.lastSeenPlaceId).toBe('pl_1')
    expect(out.report[0]).toMatchObject({ result: 'applied', reason: 'moved' })
  })

  it('移到没登记的地点：自动建出来，而不是丢弃这条 op', () => {
    const out = applyPatch(
      state(),
      [{ op: 'move-to', ref: '三号仓库', who: '林昭', evidence: 'x' }],
      ctx({ protagId: 'ch_1' }),
    )
    expect(out.state.places).toHaveLength(2)
    const created = out.state.places.find((p) => p.name === '三号仓库')
    expect(created).toBeDefined()
    expect(out.placeId).toBe(created?.id)
    expect(out.report[0]).toMatchObject({ reason: 'created' })
  })

  it('没写 who 时落到视角人物身上', () => {
    const out = applyPatch(
      state(),
      [{ op: 'move-to', ref: '同福客栈', evidence: 'x' }],
      ctx({ protagId: 'ch_2' }),
    )
    expect(out.state.cast.find((c) => c.id === 'ch_2')?.lastSeenPlaceId).toBe('pl_1')
    expect(out.state.cast.find((c) => c.id === 'ch_1')?.lastSeenPlaceId).toBeNull()
  })

  it('没有移动时 placeId 为 null（调用方沿用上一幕）', () => {
    const out = applyPatch(
      state(),
      [{ op: 'append-clue', kind: 'open-thread', text: '天亮了', evidence: 'x' }],
      ctx(),
    )
    expect(out.placeId).toBeNull()
  })

  it('同一批里多条移动：以最后一条为准', () => {
    const out = applyPatch(
      state(),
      [
        { op: 'move-to', ref: '同福客栈', evidence: 'x' },
        { op: 'move-to', ref: '三号仓库', evidence: 'x' },
      ],
      ctx({ protagId: 'ch_1' }),
    )
    const last = out.state.places.find((p) => p.name === '三号仓库')
    expect(out.placeId).toBe(last?.id)
    expect(out.state.cast.find((c) => c.id === 'ch_1')?.lastSeenPlaceId).toBe(last?.id)
  })
})

describe('append-clue · 两段式与全局收敛', () => {
  const state = () => makeState({ cast: [makeCast({ name: '林昭' })] })
  const open = (known: string, unknown: string) => ({
    id: `cl_${unknown.length}_${unknown.charCodeAt(0)}`,
    kind: 'open-thread' as const,
    known,
    unknown,
    text: unknown,
    thread: { kind: 'main' as const, id: null, label: '主线' },
    sceneId: 'sc_0',
    status: 'open' as const,
    resolvedAtSceneId: null,
  })

  it('两段式入库：known 与 unknown 各归各位，text 是 unknown 的别名', () => {
    const out = applyPatch(
      state(),
      [
        {
          op: 'append-clue',
          kind: 'open-thread',
          known: '掌柜每晚上楼前都问雾几时散',
          unknown: '他上楼那几夜到底在做什么',
          evidence: 'x',
        },
      ],
      ctx(),
    )
    expect(out.clues).toHaveLength(1)
    expect(out.clues[0].known).toBe('掌柜每晚上楼前都问雾几时散')
    expect(out.clues[0].unknown).toBe('他上楼那几夜到底在做什么')
    expect(out.clues[0].text).toBe(out.clues[0].unknown)
  })

  it('只有陈述句、没有问句时拒收（陈述句入库后永远不会变成问题）', () => {
    const out = applyPatch(
      state(),
      [{ op: 'append-clue', kind: 'open-thread', text: '周慕之每回上楼前都在柜台前问雾几时散', evidence: 'x' }],
      ctx(),
    )
    expect(out.clues).toHaveLength(0)
    expect(out.report[0]).toMatchObject({ result: 'skipped', reason: 'clue-no-question' })
  })

  it('没有已知部分时拒收：没有来由的问题不值得追', () => {
    const out = applyPatch(
      state(),
      [{ op: 'append-clue', kind: 'open-thread', unknown: '那封信到底藏在哪儿', evidence: 'x' }],
      ctx(),
    )
    expect(out.clues).toHaveLength(0)
    expect(out.report[0]).toMatchObject({ result: 'skipped', reason: 'clue-no-known' })
  })

  it('全局已达上限时拒收新线索，且不报错', () => {
    const existing = Array.from({ length: 12 }, (_, i) => open(`已知${i}`, `旧的问题还在吗${i}`))
    const out = applyPatch(
      state(),
      [{ op: 'append-clue', kind: 'open-thread', known: '新的已知', unknown: '全新的问题是什么', evidence: 'x' }],
      ctx({ existingOpenClues: existing, maxOpenClues: 12 }),
    )
    expect(out.clues).toHaveLength(0)
    expect(out.report[0]).toMatchObject({ result: 'skipped', reason: 'clue-overflow' })
  })

  it('未达上限时正常记录', () => {
    const existing = Array.from({ length: 5 }, (_, i) => open(`已知${i}`, `旧的问题还在吗${i}`))
    const out = applyPatch(
      state(),
      [{ op: 'append-clue', kind: 'open-thread', known: '新的已知', unknown: '全新的问题是什么', evidence: 'x' }],
      ctx({ existingOpenClues: existing, maxOpenClues: 12 }),
    )
    expect(out.clues).toHaveLength(1)
    expect(out.report[0]).toMatchObject({ result: 'applied' })
  })

  it('同一件事换个问法：按 known 判重', () => {
    const out = applyPatch(
      state(),
      [
        {
          op: 'append-clue',
          kind: 'open-thread',
          known: '三号仓库的提货单被海关扣下，说要查旧账',
          unknown: '海关为什么要查这批货',
          evidence: 'x',
        },
      ],
      ctx({
        existingOpenClues: [open('海关扣了三号仓库的提货单，说要查旧账', '那批货还能不能提出来')],
        maxOpenClues: 12,
      }),
    )
    expect(out.clues).toHaveLength(0)
    expect(out.report[0]).toMatchObject({ reason: 'similar' })
  })

  it('不传 existingOpenClues 时退化为只按本幕去重（旧调用方不受影响）', () => {
    const out = applyPatch(
      state(),
      [{ op: 'append-clue', kind: 'open-thread', known: '某件事', unknown: '这件事为什么发生', evidence: 'x' }],
      ctx(),
    )
    expect(out.clues).toHaveLength(1)
  })
})

describe('目标 · 增删与达成', () => {
  const base = () =>
    ctx({
      objectives: [
        {
          id: 'ob_1',
          text: '查清父亲十年前那夜是怎么死的',
          kind: 'main',
          status: 'active',
          atSceneId: null,
          origin: 'user',
        },
      ],
    })

  it('add-objective 追加一条支线目标', () => {
    const out = applyPatch(
      makeState(),
      [{ op: 'add-objective', text: '找到初七夜那条船的船老大', evidence: 'x' }],
      base(),
    )
    expect(out.objectives).toHaveLength(2)
    expect(out.objectives?.[1]).toMatchObject({ kind: 'side', origin: 'extract', status: 'active' })
  })

  it('重复的目标不会记两条', () => {
    const out = applyPatch(
      makeState(),
      [
        { op: 'add-objective', text: '找到初七夜那条船的船老大', evidence: 'x' },
        { op: 'add-objective', text: '找到初七夜那条船的船老大', evidence: 'x' },
      ],
      base(),
    )
    expect(out.objectives).toHaveLength(2)
    expect(out.report[1]).toMatchObject({ reason: 'duplicate' })
  })

  it('achieve-objective 用片段命中完整目标', () => {
    const out = applyPatch(
      makeState(),
      [{ op: 'achieve-objective', ref: '查清父亲死因', evidence: 'x' }],
      base(),
    )
    const main = out.objectives?.find((o) => o.kind === 'main')
    expect(main?.status).toBe('done')
    expect(main?.atSceneId).toBe('sc_2')
  })

  it('达成不存在的目标时跳过，不报错', () => {
    const out = applyPatch(
      makeState(),
      [{ op: 'achieve-objective', ref: '找到外星人', evidence: 'x' }],
      base(),
    )
    expect(out.report[0]).toMatchObject({ result: 'skipped', reason: 'not-found' })
  })

  it('已达成的目标不会被重复达成', () => {
    const out = applyPatch(
      makeState(),
      [
        { op: 'achieve-objective', ref: '查清父亲死因', evidence: 'x' },
        { op: 'achieve-objective', ref: '查清父亲死因', evidence: 'x' },
      ],
      base(),
    )
    expect(out.report[1]).toMatchObject({ result: 'skipped' })
  })

  it('没有目标类 op 时不返回 objectives（调用方不必白写一次库）', () => {
    const out = applyPatch(
      makeState(),
      [{ op: 'append-clue', kind: 'open-thread', text: '还没答案的事', evidence: 'x' }],
      base(),
    )
    expect(out.objectives).toBeUndefined()
  })
})

describe('人物属性 · 能力与隐藏项', () => {
  const state = () => makeState({ cast: [makeCast({ id: 'ch_1', name: '林昭' })] })

  it('能力只增不减且去重', () => {
    const out = applyPatch(
      state(),
      [
        { op: 'upsert-cast', ref: '林昭', evidence: 'x', value: { abilities: ['看手相', '开枪'] } },
        { op: 'upsert-cast', ref: '林昭', evidence: 'x', value: { abilities: ['看手相', '游泳'] } },
      ],
      ctx(),
    )
    expect(out.state.cast[0].abilities).toEqual(['看手相', '开枪', '游泳'])
  })

  it('能力上限 6 条', () => {
    const out = applyPatch(
      state(),
      [
        {
          op: 'upsert-cast',
          ref: '林昭',
          evidence: 'x',
          value: { abilities: Array.from({ length: 9 }, (_, i) => `本事${i}`) },
        },
      ],
      ctx(),
    )
    expect(out.state.cast[0].abilities).toHaveLength(6)
  })

  it('爱好上限 4 条', () => {
    const out = applyPatch(
      state(),
      [
        {
          op: 'upsert-cast',
          ref: '林昭',
          evidence: 'x',
          value: { hobbies: Array.from({ length: 7 }, (_, i) => `爱好${i}`) },
        },
      ],
      ctx(),
    )
    expect(out.state.cast[0].hobbies).toHaveLength(4)
  })

  it('reveal-hidden 标记已有秘密', () => {
    const base = makeState({
      cast: [
        makeCast({
          id: 'ch_1',
          name: '林昭',
          hidden: [{ text: '他其实是缉私队的线人', revealedAt: null }],
        }),
      ],
    })
    const out = applyPatch(
      base,
      [{ op: 'reveal-hidden', ref: '林昭', what: '缉私队的线人', evidence: 'x' }],
      ctx(),
    )
    expect(out.state.cast[0].hidden[0].revealedAt).toBe('sc_2')
    expect(out.report[0]).toMatchObject({ result: 'applied', reason: 'revealed' })
  })

  it('揭示没登记过的秘密时补一条并直接标为已揭', () => {
    const out = applyPatch(
      state(),
      [{ op: 'reveal-hidden', ref: '林昭', what: '他认得那个船老大', evidence: 'x' }],
      ctx(),
    )
    expect(out.state.cast[0].hidden).toHaveLength(1)
    expect(out.state.cast[0].hidden[0].revealedAt).toBe('sc_2')
  })

  it('角色不存在时跳过', () => {
    const out = applyPatch(
      state(),
      [{ op: 'reveal-hidden', ref: '查无此人', what: '某事', evidence: 'x' }],
      ctx(),
    )
    expect(out.report[0]).toMatchObject({ result: 'skipped', reason: 'not-found' })
  })
})

describe('resolve-clue · 跨幕收线', () => {
  const oldClue = (over: Partial<Clue> = {}): Clue => ({
    id: 'cl_old',
    kind: 'open-thread',
    known: '掌柜每晚上楼前都问雾几时散',
    unknown: '他上楼那几夜到底在做什么',
    text: '他上楼那几夜到底在做什么',
    thread: { kind: 'main', id: null, label: '主线' },
    sceneId: 'sc_1',
    status: 'open',
    resolvedAtSceneId: null,
    ...over,
  })

  it('按编号收掉旧线索，并把 id 交回调用方', () => {
    const out = applyPatch(
      makeState(),
      [{ op: 'resolve-clue', ref: '#1', evidence: 'x' }],
      ctx({ existingOpenClues: [oldClue()] }),
    )
    expect(out.resolvedClueIds).toEqual(['cl_old'])
    expect(out.report[0]).toMatchObject({ result: 'applied', reason: 'resolved' })
  })

  it('编号越界且文本对不上时不误收', () => {
    const out = applyPatch(
      makeState(),
      [{ op: 'resolve-clue', ref: '#9', evidence: 'x' }],
      ctx({ existingOpenClues: [oldClue()] }),
    )
    expect(out.resolvedClueIds).toEqual([])
    expect(out.report[0].reason).toBe('no-open-clue')
  })

  it('措辞被改写也能认出（相似度兜底）', () => {
    const out = applyPatch(
      makeState(),
      [{ op: 'resolve-clue', ref: '他上楼那几夜到底做什么', evidence: 'x' }],
      ctx({ existingOpenClues: [oldClue()] }),
    )
    expect(out.resolvedClueIds).toEqual(['cl_old'])
  })

  it('本幕刚开的线索当场收掉，不计入跨幕', () => {
    const out = applyPatch(
      makeState(),
      [
        {
          op: 'append-clue',
          kind: 'open-thread',
          known: '雾里有人拉汽笛',
          unknown: '雾里的汽笛是谁拉的',
          evidence: 'x',
        },
        { op: 'resolve-clue', ref: '#1', evidence: 'x' },
      ],
      ctx(),
    )
    expect(out.clues[0].status).toBe('resolved')
    expect(out.resolvedClueIds).toEqual([])
  })

  it('一幕最多开两条，第三条记 clue-burst', () => {
    const out = applyPatch(
      makeState(),
      [
        { op: 'append-clue', kind: 'open-thread', known: '货单被扣在海关', unknown: '谁把货单扣下了', evidence: 'x' },
        { op: 'append-clue', kind: 'open-thread', known: '姓周那晚不在船上', unknown: '姓周的去了哪里', evidence: 'x' },
        { op: 'append-clue', kind: 'open-thread', known: '掌柜认得那封信', unknown: '掌柜为什么装作不认得', evidence: 'x' },
      ],
      ctx(),
    )
    expect(out.clues).toHaveLength(2)
    expect(out.report[2]).toMatchObject({ result: 'skipped', reason: 'clue-burst' })
  })
})

describe('add-objective · 目标的闸门', () => {
  const main = {
    id: 'ob_main',
    text: '查清父亲的死因',
    kind: 'main' as const,
    status: 'active' as const,
    atSceneId: null,
    origin: 'user' as const,
  }

  it('已有主线时拒绝新增 main', () => {
    const out = applyPatch(
      makeState(),
      [{ op: 'add-objective', text: '打听姓林的人', kind: 'main', evidence: 'x' }],
      ctx({ objectives: [main] }),
    )
    expect(out.objectives?.filter((o) => o.kind === 'main')).toHaveLength(1)
    expect(out.report[0]).toMatchObject({ result: 'skipped', reason: 'main-locked' })
  })

  it('同一件事换个说法不重复记', () => {
    const out = applyPatch(
      makeState(),
      [{ op: 'add-objective', text: '去找老瘸子打听那封信', kind: 'side', evidence: 'x' }],
      ctx({
        objectives: [
          main,
          { ...main, id: 'ob_s', kind: 'side', text: '赶在天黑前找老瘸子问那封信的下落', origin: 'extract' },
        ],
      }),
    )
    expect(out.report[0]).toMatchObject({ result: 'skipped', reason: 'duplicate' })
  })

  it('支线满 3 条后不再新增', () => {
    const sides = [1, 2, 3].map((i) => ({
      ...main,
      id: `ob_${i}`,
      kind: 'side' as const,
      text: `支线任务第${i}件不同的事`,
      origin: 'extract' as const,
    }))
    const out = applyPatch(
      makeState(),
      [{ op: 'add-objective', text: '去北边灯塔找守塔人核对潮汐表', kind: 'side', evidence: 'x' }],
      ctx({ objectives: [main, ...sides] }),
    )
    expect(out.report[0]).toMatchObject({ result: 'skipped', reason: 'objective-cap' })
  })
})
