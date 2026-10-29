import { describe, expect, it } from 'vitest'
import { ancestorsOf, isWithin, placePath, resolvePlaceRef } from '../../src/domain/place'
import { makePlace } from '../helpers'

const places = () => [
  makePlace({ id: 'pl_city', name: '雾港' }),
  makePlace({ id: 'pl_wh', name: '三号仓库', parentId: 'pl_city' }),
  makePlace({ id: 'pl_room', name: '侧门小屋', parentId: 'pl_wh' }),
  makePlace({ id: 'pl_inn', name: '同福客栈', parentId: 'pl_city' }),
]

describe('ancestorsOf / placePath', () => {
  it('从顶层到自身', () => {
    expect(ancestorsOf(places(), 'pl_room').map((p) => p.name)).toEqual([
      '雾港',
      '三号仓库',
      '侧门小屋',
    ])
  })

  it('路径用 / 连接', () => {
    expect(placePath(places(), 'pl_room')).toBe('雾港 / 三号仓库 / 侧门小屋')
  })

  it('顶层地点路径就是自己', () => {
    expect(placePath(places(), 'pl_city')).toBe('雾港')
  })

  it('id 为空时返回空串', () => {
    expect(placePath(places(), null)).toBe('')
  })

  it('父子成环时不会死循环', () => {
    const cyclic = [
      makePlace({ id: 'a', name: '甲', parentId: 'b' }),
      makePlace({ id: 'b', name: '乙', parentId: 'a' }),
    ]
    expect(ancestorsOf(cyclic, 'a')).toHaveLength(2)
  })

  it('超过三层就截断（再深只增加 prompt 噪音）', () => {
    const deep = [
      makePlace({ id: 'l1', name: '一层' }),
      makePlace({ id: 'l2', name: '二层', parentId: 'l1' }),
      makePlace({ id: 'l3', name: '三层', parentId: 'l2' }),
      makePlace({ id: 'l4', name: '四层', parentId: 'l3' }),
    ]
    expect(ancestorsOf(deep, 'l4')).toHaveLength(3)
  })
})

describe('isWithin', () => {
  it('子地点算在父地点之内', () => {
    expect(isWithin(places(), 'pl_room', 'pl_wh')).toBe(true)
    expect(isWithin(places(), 'pl_room', 'pl_city')).toBe(true)
  })

  it('同级地点互不包含', () => {
    expect(isWithin(places(), 'pl_inn', 'pl_wh')).toBe(false)
  })

  it('自己包含自己（用于「还在这栋楼里」的判断）', () => {
    expect(isWithin(places(), 'pl_wh', 'pl_wh')).toBe(true)
  })
})

describe('resolvePlaceRef · 最长匹配', () => {
  it('精确命中', () => {
    expect(resolvePlaceRef(places(), '三号仓库')?.place.id).toBe('pl_wh')
  })

  it('正文里写更具体的地点时落到具体的那个，而不是父级', () => {
    const hit = resolvePlaceRef(places(), '三号仓库的侧门小屋')
    expect(hit?.place.id).toBe('pl_room')
  })

  it('反过来说得含糊时落到能匹配上的那个', () => {
    expect(resolvePlaceRef(places(), '仓库')?.place.id).toBe('pl_wh')
  })

  it('多个候选时取名字最长的（更具体）', () => {
    const many = [
      makePlace({ id: 'a', name: '仓库' }),
      makePlace({ id: 'b', name: '三号仓库' }),
    ]
    expect(resolvePlaceRef(many, '三号仓库')?.place.id).toBe('b')
  })

  it('认不出来时返回 null（让调用方新建）', () => {
    expect(resolvePlaceRef(places(), '旧港码头')).toBeNull()
  })

  it('软删的地点不参与匹配', () => {
    const removed = [makePlace({ id: 'x', name: '废屋', removedAt: 1 })]
    expect(resolvePlaceRef(removed, '废屋')).toBeNull()
  })
})
