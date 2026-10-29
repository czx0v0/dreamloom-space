import { describe, expect, it } from 'vitest'
import { resolvePov } from '../../src/domain/pov'
import { makeCast } from '../helpers'

describe('resolvePov', () => {
  const cast = [makeCast({ id: 'ch_1', name: '林昭' }), makeCast({ id: 'ch_2', name: '掌柜' })]

  it('第一人称且有主角：生效并带出名字', () => {
    expect(resolvePov('first', 'ch_1', cast)).toEqual({
      pov: 'first',
      protagName: '林昭',
      downgraded: false,
    })
  })

  it('第一人称但没有主角：降级为第三人称（否则会写出混乱的「我」）', () => {
    expect(resolvePov('first', null, cast)).toEqual({
      pov: 'third',
      protagName: null,
      downgraded: true,
    })
  })

  it('主角已被软删：同样降级', () => {
    const removed = [makeCast({ id: 'ch_1', name: '林昭', removedAt: 100 })]
    expect(resolvePov('first', 'ch_1', removed)).toMatchObject({
      pov: 'third',
      downgraded: true,
    })
  })

  it('主角已被合并：同样降级', () => {
    const merged = [makeCast({ id: 'ch_1', name: '林昭', supersededBy: 'ch_9' })]
    expect(resolvePov('first', 'ch_1', merged)).toMatchObject({ pov: 'third', downgraded: true })
  })

  it('第三人称照常带出主角名', () => {
    expect(resolvePov('third', 'ch_1', cast)).toEqual({
      pov: 'third',
      protagName: '林昭',
      downgraded: false,
    })
  })

  it('旁观视角生效：主角名照旧返回，但 prompt 的旁观分支不消费它', () => {
    expect(resolvePov('watcher', 'ch_1', cast)).toEqual({
      pov: 'watcher',
      protagName: '林昭',
      downgraded: false,
    })
  })

  it('第三人称无主角也能用（镜头跟随场景主要人物）', () => {
    expect(resolvePov('third', null, cast)).toEqual({
      pov: 'third',
      protagName: null,
      downgraded: false,
    })
  })
})
