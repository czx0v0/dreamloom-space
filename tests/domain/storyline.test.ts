import { describe, expect, it } from 'vitest'
import { applyPatch, type ApplyContext } from '../../src/domain/patch'
import type { PatchOp } from '../../src/domain/types'
import { idGenFactory, makeCast, makePlace, makeState } from '../helpers'

function ctx(over: Partial<ApplyContext> = {}): ApplyContext {
  return {
    spaceId: 'sp_1',
    sceneId: 'sc_5',
    now: 500,
    existingClues: [],
    idGen: idGenFactory(),
    ...over,
  }
}

describe('append-arc · 角色故事线', () => {
  it('追加一条经历', () => {
    const cast = makeCast({ name: '林昭' })
    const out = applyPatch(
      makeState({ cast: [cast] }),
      [{ op: 'append-arc', ref: '林昭', kind: 'reveal', text: '得知父亲并非意外身亡', evidence: 'x' }],
      ctx(),
    )
    expect(out.state.cast[0].arc).toHaveLength(1)
    expect(out.state.cast[0].arc[0]).toMatchObject({
      sceneId: 'sc_5',
      kind: 'reveal',
      text: '得知父亲并非意外身亡',
    })
  })

  it('找不到角色时跳过', () => {
    const out = applyPatch(
      makeState(),
      [{ op: 'append-arc', ref: '不存在', kind: 'turn', text: 'x', evidence: 'x' }],
      ctx(),
    )
    expect(out.report[0]).toMatchObject({ result: 'skipped', reason: 'not-found' })
  })

  it('超过上限时优先保留 loss/turn，丢弃 meeting', () => {
    const cast = makeCast({
      name: '林昭',
      arc: [
        { sceneId: 'sc_1', text: '初见', kind: 'meeting', at: 1 },
        { sceneId: 'sc_2', text: '失去父亲', kind: 'loss', at: 2 },
      ],
    })
    const ops: PatchOp[] = [
      { op: 'append-arc', ref: '林昭', kind: 'meeting', text: '又见', evidence: 'x' },
    ]
    const out = applyPatch(makeState({ cast: [cast] }), ops, ctx({ maxArc: 2 }))
    const texts = out.state.cast[0].arc.map((b) => b.text)
    expect(out.state.cast[0].arc).toHaveLength(2)
    expect(texts).toContain('失去父亲')
    expect(texts).toContain('又见')
    expect(texts).not.toContain('初见')
  })
})

describe('append-place-event · 地点事件账本', () => {
  it('追加事件', () => {
    const place = makePlace({ name: '同福客栈' })
    const out = applyPatch(
      makeState({ places: [place] }),
      [{ op: 'append-place-event', ref: '同福客栈', text: '这里死过一个账房', evidence: 'x' }],
      ctx(),
    )
    expect(out.state.places[0].events).toHaveLength(1)
    expect(out.state.places[0].events[0].text).toBe('这里死过一个账房')
  })

  it('超过上限时保留最近事件', () => {
    const place = makePlace({
      name: '同福客栈',
      events: Array.from({ length: 3 }, (_, i) => ({
        sceneId: `sc_${i}`,
        text: `事件${i}`,
        at: i,
      })),
    })
    const out = applyPatch(
      makeState({ places: [place] }),
      [{ op: 'append-place-event', ref: '同福客栈', text: '最新事件', evidence: 'x' }],
      ctx({ maxPlaceEvents: 2 }),
    )
    const texts = out.state.places[0].events.map((e) => e.text)
    expect(out.state.places[0].events).toHaveLength(2)
    expect(texts).toContain('最新事件')
  })
})

describe('resolve-clue · 伏笔收起', () => {
  it('按文本片段收掉最近一条未解线索', () => {
    const out = applyPatch(
      makeState(),
      [
        {
          op: 'append-clue',
          kind: 'open-thread',
          known: '信上只有三个字',
          unknown: '那三个字是什么意思',
          evidence: 'x',
        },
        { op: 'resolve-clue', ref: '三个字', evidence: 'x' },
      ],
      ctx(),
    )
    expect(out.clues).toHaveLength(1)
    expect(out.clues[0].status).toBe('resolved')
    expect(out.clues[0].resolvedAtSceneId).toBe('sc_5')
  })

  it('匹配不到时跳过，不误伤其他线索', () => {
    const out = applyPatch(
      makeState(),
      [
        {
          op: 'append-clue',
          kind: 'open-thread',
          known: '信上只有三个字',
          unknown: '那三个字是什么意思',
          evidence: 'x',
        },
        { op: 'resolve-clue', ref: '无人机', evidence: 'x' },
      ],
      ctx(),
    )
    expect(out.clues[0].status).toBe('open')
    expect(out.report[1]).toMatchObject({ result: 'skipped', reason: 'no-open-clue' })
  })

  it('已收的线索不会被重复收', () => {
    const out = applyPatch(
      makeState(),
      [
        {
          op: 'append-clue',
          kind: 'open-thread',
          known: '他托我找女儿',
          unknown: '他女儿到底在哪儿',
          evidence: 'x',
        },
        { op: 'resolve-clue', ref: '女儿', evidence: 'x' },
        { op: 'resolve-clue', ref: '女儿', evidence: 'x' },
      ],
      ctx(),
    )
    expect(out.report[2]).toMatchObject({ result: 'skipped' })
  })
})

describe('幂等性（含新 op）', () => {
  it('同一 patch 连应用两次状态一致', () => {
    const cast = makeCast({ name: '林昭' })
    const place = makePlace({ name: '同福客栈' })
    const ops: PatchOp[] = [
      { op: 'append-arc', ref: '林昭', kind: 'turn', text: '决定留下', evidence: 'x' },
      { op: 'append-place-event', ref: '同福客栈', text: '起了火', evidence: 'x' },
      { op: 'append-clue', kind: 'open-thread', known: '夜里起了火', unknown: '火是谁放的', evidence: 'x' },
    ]
    const first = applyPatch(makeState({ cast: [cast], places: [place] }), ops, ctx())
    const second = applyPatch(first.state, ops, ctx({ existingClues: first.clues }))
    expect(second.state.cast[0].arc).toHaveLength(1)
    expect(second.state.places[0].events).toHaveLength(1)
    expect(second.clues).toHaveLength(1)
  })
})

describe('assert-fact · 状态事实', () => {
  it('记录一条确定事实', () => {
    const out = applyPatch(
      makeState(),
      [
        {
          op: 'assert-fact',
          subject: '信',
          predicate: '写着',
          object: '三个字',
          kind: 'number',
          evidence: 'x',
        },
      ],
      ctx(),
    )
    expect(out.state.facts).toHaveLength(1)
    expect(out.state.facts[0]).toMatchObject({
      subject: '信',
      predicate: '写着',
      object: '三个字',
      kind: 'number',
      status: 'active',
    })
  })

  it('同主语同谓词的对象改写时，旧记录置 retracted 而不是删除', () => {
    const out = applyPatch(
      makeState(),
      [
        { op: 'assert-fact', subject: '信', predicate: '写着', object: '三个字', kind: 'number', evidence: 'x' },
        { op: 'assert-fact', subject: '信', predicate: '写着', object: '五个字', kind: 'number', evidence: 'x' },
      ],
      ctx(),
    )
    expect(out.state.facts).toHaveLength(2)
    const active = out.state.facts.filter((f) => f.status === 'active')
    expect(active).toHaveLength(1)
    expect(active[0].object).toBe('五个字')
    expect(out.report[1]).toMatchObject({ result: 'applied', reason: 'superseded' })
  })

  it('完全相同的事实重复记录会被跳过（幂等）', () => {
    const ops: PatchOp[] = [
      { op: 'assert-fact', subject: '井', predicate: '位于', object: '后厨', kind: 'place', evidence: 'x' },
    ]
    const first = applyPatch(makeState(), ops, ctx())
    const second = applyPatch(first.state, ops, ctx())
    expect(second.state.facts).toHaveLength(1)
    expect(second.report[0]).toMatchObject({ result: 'skipped', reason: 'duplicate' })
  })

  it('retract 按文本片段撤销最近一条', () => {
    const out = applyPatch(
      makeState(),
      [
        { op: 'assert-fact', subject: '林昭', predicate: '持有', object: '一封旧信', kind: 'object', evidence: 'x' },
        { op: 'retract-fact', ref: '旧信', evidence: 'x' },
      ],
      ctx(),
    )
    expect(out.state.facts[0].status).toBe('retracted')
  })

  it('撤销不存在的事实时跳过', () => {
    const out = applyPatch(
      makeState(),
      [{ op: 'retract-fact', ref: '无人机', evidence: 'x' }],
      ctx(),
    )
    expect(out.report[0]).toMatchObject({ result: 'skipped', reason: 'not-found' })
  })

  it('超过上限时优先保留 promise / number', () => {
    const facts = Array.from({ length: 3 }, (_, i) => ({
      id: `ft_${i}`,
      subject: `事${i}`,
      predicate: '是',
      object: 'x',
      kind: 'other' as const,
      sceneId: 'sc_1',
      status: 'active' as const,
      updatedAt: i,
    }))
    const out = applyPatch(
      makeState({ facts }),
      [
        {
          op: 'assert-fact',
          subject: '约定',
          predicate: '是',
          object: '三天后回来',
          kind: 'promise',
          evidence: 'x',
        },
      ],
      ctx({ maxFacts: 2 }),
    )
    const active = out.state.facts.filter((f) => f.status === 'active')
    expect(out.state.facts).toHaveLength(2)
    expect(active.some((f) => f.kind === 'promise')).toBe(true)
  })
})
