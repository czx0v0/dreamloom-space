import { describe, expect, it } from 'vitest'
import {
  mainObjective,
  objectiveProgress,
  resolvePhase,
} from '../../src/domain/objective'
import type { Objective } from '../../src/domain/types'

const obj = (over: Partial<Objective> = {}): Objective => ({
  id: 'ob_1',
  text: '查清父亲死因',
  kind: 'main',
  status: 'active',
  atSceneId: null,
  origin: 'user',
  ...over,
})

const meta = (objectives: Objective[], endedAt: number | null = null, mode: 'goal' | 'free' = 'goal') => ({
  objectives,
  endedAt,
  mode,
})

describe('objectiveProgress', () => {
  it('没有目标时比例为 0，而不是 1', () => {
    const p = objectiveProgress({ objectives: [] })
    expect(p.ratio).toBe(0)
    expect(p.total).toBe(0)
  })

  it('按 done 数算比例', () => {
    const p = objectiveProgress({ objectives: [obj(), obj({ id: 'b', status: 'done' })] })
    expect(p.done).toBe(1)
    expect(p.ratio).toBe(0.5)
  })

  it('mainDone 只看主目标', () => {
    const side = obj({ id: 's', kind: 'side', status: 'done' })
    expect(objectiveProgress({ objectives: [obj(), side] }).mainDone).toBe(false)
    expect(objectiveProgress({ objectives: [obj({ status: 'done' })] }).mainDone).toBe(true)
  })

  it('mainObjective 取第一条 main', () => {
    expect(mainObjective({ objectives: [obj()] })?.id).toBe('ob_1')
    expect(mainObjective({ objectives: [] })).toBeNull()
  })
})

describe('resolvePhase · 五档', () => {
  it('结局已写就是 closed，优先于一切', () => {
    expect(resolvePhase(meta([obj({ status: 'done' })], 123), 30)).toBe('closed')
  })

  it('主目标达成即 ending，不必等幕数', () => {
    expect(resolvePhase(meta([obj({ status: 'done' })]), 3)).toBe('ending')
  })

  it('前 5 幕是开场', () => {
    expect(resolvePhase(meta([obj()]), 0)).toBe('opening')
    expect(resolvePhase(meta([obj()]), 4)).toBe('opening')
  })

  it('5–24 幕是调查', () => {
    expect(resolvePhase(meta([obj()]), 5)).toBe('investigation')
    expect(resolvePhase(meta([obj()]), 24)).toBe('investigation')
  })

  it('25 幕起进入逼近（催收）', () => {
    expect(resolvePhase(meta([obj()]), 25)).toBe('climax')
    expect(resolvePhase(meta([obj()]), 100)).toBe('climax')
  })

  it('没有目标时也按幕数给阶段（不至于没有节奏提示）', () => {
    expect(resolvePhase(meta([]), 3)).toBe('opening')
    expect(resolvePhase(meta([]), 30)).toBe('climax')
  })
})

describe('resolvePhase · 自由模式', () => {
  it('free 模式固定返回 free，不看目标与幕数', () => {
    expect(resolvePhase(meta([obj()], null, 'free'), 10)).toBe('free')
    expect(resolvePhase(meta([obj({ status: 'done' })], null, 'free'), 10)).toBe('free')
  })

  it('但写了结局仍然算 closed（锁盘优先）', () => {
    expect(resolvePhase(meta([obj()], 123, 'free'), 10)).toBe('closed')
  })
})
