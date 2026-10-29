import { describe, expect, it } from 'vitest'
import { mergeCast } from '../../src/domain/merge'
import { makeCast, makeRelation, makeState } from '../helpers'

function setup() {
  const winner = makeCast({ id: 'ch_a', name: '林昭', aliases: ['林记者'], traits: ['冷静'] })
  const loser = makeCast({ id: 'ch_b', name: '林老板', aliases: ['老林'], traits: ['冷静', '固执'] })
  return { winner, loser }
}

describe('mergeCast · 别名与特征', () => {
  it('赢家保留自己的名字，输家名字与别名都进别名表', () => {
    const { winner, loser } = setup()
    const out = mergeCast(makeState({ cast: [winner, loser] }), 'ch_a', 'ch_b', 1000)
    const merged = out.state.cast.find((c) => c.id === 'ch_a')!
    expect(merged.name).toBe('林昭')
    expect(merged.aliases).toEqual(expect.arrayContaining(['林老板', '老林']))
    expect(out.aliasesMoved).toBe(2)
  })

  it('特征去重合并', () => {
    const { winner, loser } = setup()
    const out = mergeCast(makeState({ cast: [winner, loser] }), 'ch_a', 'ch_b', 1000)
    const merged = out.state.cast.find((c) => c.id === 'ch_a')!
    expect(merged.traits).toEqual(['冷静', '固执'])
  })

  it('输家不删除，置 supersededBy 可追溯', () => {
    const { winner, loser } = setup()
    const out = mergeCast(makeState({ cast: [winner, loser] }), 'ch_a', 'ch_b', 1000)
    const old = out.state.cast.find((c) => c.id === 'ch_b')!
    expect(old.supersededBy).toBe('ch_a')
    expect(old.removedAt).toBe(1000)
  })
})

describe('mergeCast · 故事线', () => {
  it('按场景与文本去重后合并', () => {
    const winner = makeCast({
      id: 'ch_a',
      name: '林昭',
      arc: [{ sceneId: 'sc_1', text: '得知真相', kind: 'reveal', at: 1 }],
    })
    const loser = makeCast({
      id: 'ch_b',
      name: '林老板',
      arc: [
        { sceneId: 'sc_1', text: '得知真相', kind: 'reveal', at: 1 },
        { sceneId: 'sc_4', text: '失去父亲', kind: 'loss', at: 4 },
      ],
    })
    const out = mergeCast(makeState({ cast: [winner, loser] }), 'ch_a', 'ch_b', 1000)
    const merged = out.state.cast.find((c) => c.id === 'ch_a')!
    expect(merged.arc).toHaveLength(2)
    expect(merged.arc.map((b) => b.text)).toEqual(['得知真相', '失去父亲'])
  })

  it('超过上限时优先保留 loss / turn', () => {
    const winner = makeCast({
      id: 'ch_a',
      name: '林昭',
      arc: [{ sceneId: 'sc_1', text: '初见', kind: 'meeting', at: 1 }],
    })
    const loser = makeCast({
      id: 'ch_b',
      name: '林老板',
      arc: [{ sceneId: 'sc_2', text: '失去父亲', kind: 'loss', at: 2 }],
    })
    const out = mergeCast(makeState({ cast: [winner, loser] }), 'ch_a', 'ch_b', 1000, 1)
    const merged = out.state.cast.find((c) => c.id === 'ch_a')!
    expect(merged.arc).toHaveLength(1)
    expect(merged.arc[0].kind).toBe('loss')
  })
})

describe('mergeCast · 状态', () => {
  it('一方已死则合并后为死（不能因合并复活）', () => {
    const winner = makeCast({ id: 'ch_a', name: '林昭', status: 'alive' })
    const loser = makeCast({ id: 'ch_b', name: '林老板', status: 'dead', statusChangedSceneId: 'sc_7' })
    const out = mergeCast(makeState({ cast: [winner, loser] }), 'ch_a', 'ch_b', 1000)
    const merged = out.state.cast.find((c) => c.id === 'ch_a')!
    expect(merged.status).toBe('dead')
    expect(merged.statusChangedSceneId).toBe('sc_7')
    expect(out.warnings.join()).toContain('复活')
  })

  it('输家 goal 在赢家为空时被继承', () => {
    const winner = makeCast({ id: 'ch_a', name: '林昭', goal: '' })
    const loser = makeCast({ id: 'ch_b', name: '林老板', goal: '找到那封信' })
    const out = mergeCast(makeState({ cast: [winner, loser] }), 'ch_a', 'ch_b', 1000)
    expect(out.state.cast.find((c) => c.id === 'ch_a')!.goal).toBe('找到那封信')
  })
})

describe('mergeCast · 关系重指', () => {
  it('指向输家的关系全部重指到赢家', () => {
    const winner = makeCast({ id: 'ch_a', name: '林昭' })
    const loser = makeCast({ id: 'ch_b', name: '林老板' })
    const other = makeCast({ id: 'ch_c', name: '掌柜' })
    const relations = [
      makeRelation({ id: 'rl_1', aId: 'ch_b', bId: 'ch_c', kind: 'enemy', edgeKey: 'ch_b|ch_c|enemy' }),
    ]
    const out = mergeCast(makeState({ cast: [winner, loser, other], relations }), 'ch_a', 'ch_b', 1000)
    expect(out.relationsRepointed).toBe(1)
    expect(out.state.relations[0].aId).toBe('ch_a')
    expect(out.state.relations[0].bId).toBe('ch_c')
    expect(out.state.relations[0].edgeKey).toBe('ch_a|ch_c|enemy')
  })

  it('重指后产生的自环被丢弃', () => {
    const winner = makeCast({ id: 'ch_a', name: '林昭' })
    const loser = makeCast({ id: 'ch_b', name: '林老板' })
    const relations = [
      makeRelation({ id: 'rl_1', aId: 'ch_a', bId: 'ch_b', kind: 'kin', edgeKey: 'ch_a|ch_b|kin' }),
    ]
    const out = mergeCast(makeState({ cast: [winner, loser], relations }), 'ch_a', 'ch_b', 1000)
    expect(out.state.relations).toHaveLength(0)
    expect(out.relationsDropped).toBe(1)
  })

  it('重指后重复的边只留一条，强度取 max', () => {
    const winner = makeCast({ id: 'ch_a', name: '林昭' })
    const loser = makeCast({ id: 'ch_b', name: '林老板' })
    const other = makeCast({ id: 'ch_c', name: '掌柜' })
    const relations = [
      makeRelation({ id: 'rl_1', aId: 'ch_a', bId: 'ch_c', kind: 'enemy', strength: 2, edgeKey: 'ch_a|ch_c|enemy' }),
      makeRelation({ id: 'rl_2', aId: 'ch_b', bId: 'ch_c', kind: 'enemy', strength: 5, edgeKey: 'ch_b|ch_c|enemy' }),
    ]
    const out = mergeCast(makeState({ cast: [winner, loser, other], relations }), 'ch_a', 'ch_b', 1000)
    expect(out.state.relations).toHaveLength(1)
    expect(out.state.relations[0].strength).toBe(5)
  })
})

describe('mergeCast · 边界', () => {
  it('不能与自己合并', () => {
    const { winner } = setup()
    const out = mergeCast(makeState({ cast: [winner] }), 'ch_a', 'ch_a', 1000)
    expect(out.warnings.join()).toContain('自己')
  })

  it('已被合并过的角色不再参与', () => {
    const winner = makeCast({ id: 'ch_a', name: '林昭' })
    const loser = makeCast({ id: 'ch_b', name: '林老板', supersededBy: 'ch_a' })
    const out = mergeCast(makeState({ cast: [winner, loser] }), 'ch_a', 'ch_b', 1000)
    expect(out.warnings.join()).toContain('已被合并')
  })

  it('合并是幂等的（第二次无副作用）', () => {
    const { winner, loser } = setup()
    const first = mergeCast(makeState({ cast: [winner, loser] }), 'ch_a', 'ch_b', 1000)
    const second = mergeCast(first.state, 'ch_a', 'ch_b', 2000)
    expect(second.warnings.join()).toContain('已被合并')
    expect(second.state.cast.find((c) => c.id === 'ch_a')!.aliases).toEqual(
      first.state.cast.find((c) => c.id === 'ch_a')!.aliases,
    )
  })
})
