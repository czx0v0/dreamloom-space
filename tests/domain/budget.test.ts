import { describe, expect, it } from 'vitest'
import { packSections, resolveCharRange } from '../../src/domain/budget'

const cfg = {
  contentBudget: 4900,
  sections: {
    rules: 400,
    action: 200,
    outline: 600,
    cast: 1200,
    lastTail: 800,
    summaries: 600,
    clues: 500,
    relations: 300,
    places: 300,
  } as Record<string, number>,
  trimOrder: ['places', 'relations', 'clues', 'summaries', 'cast', 'lastTail', 'outline'],
  pinned: ['rules', 'action'],
}

describe('packSections', () => {
  it('不超预算时原样保留', () => {
    const out = packSections({ rules: '铁律', action: '推门', cast: '林昭' }, cfg)
    expect(out.dropped).toEqual([])
    expect(out.ok).toBe(true)
    expect(out.sections.cast).toBe('林昭')
  })

  it('单分区超限时截断到上限', () => {
    const out = packSections({ cast: '林'.repeat(2000) }, cfg)
    expect(out.sections.cast.length).toBe(1200)
    expect(out.truncated).toContain('cast')
  })

  it('超预算时严格按 trimOrder 裁剪', () => {
    const big = (n: number) => '字'.repeat(n)
    const out = packSections(
      {
        rules: big(400),
        action: big(200),
        outline: big(600),
        cast: big(1200),
        lastTail: big(800),
        summaries: big(600),
        clues: big(500),
        relations: big(300),
        places: big(300),
      },
      { ...cfg, contentBudget: 4300 },
    )
    expect(out.dropped[0]).toBe('places')
    expect(out.dropped[1]).toBe('relations')
    expect(out.dropped).not.toContain('rules')
  })

  it('pinned 分区在极端超预算下仍然存在', () => {
    const big = (n: number) => '字'.repeat(n)
    const out = packSections(
      {
        rules: big(400),
        action: big(200),
        cast: big(1200),
        lastTail: big(800),
        summaries: big(600),
        clues: big(500),
        relations: big(300),
        places: big(300),
        outline: big(600),
      },
      { ...cfg, contentBudget: 700 },
    )
    expect(out.sections.rules).toBeDefined()
    expect(out.sections.action).toBeDefined()
    expect(out.usedChars).toBeLessThanOrEqual(700 + 600)
  })

  it('不变式：usedChars 不超过 contentBudget', () => {
    const big = (n: number) => '字'.repeat(n)
    const out = packSections(
      {
        rules: big(400),
        action: big(200),
        cast: big(1200),
        lastTail: big(800),
        summaries: big(600),
        clues: big(500),
        relations: big(300),
        places: big(300),
        outline: big(600),
      },
      { ...cfg, contentBudget: 3000 },
    )
    expect(out.usedChars).toBeLessThanOrEqual(3000)
  })

  it('空字符串分区被忽略', () => {
    const out = packSections({ cast: '  ', places: '' }, cfg)
    expect(Object.keys(out.sections)).toHaveLength(0)
  })
})

describe('resolveCharRange', () => {
  const presets = { short: { min: 300, max: 450 }, medium: { min: 450, max: 700 } }

  it('命中档位', () => {
    expect(resolveCharRange(presets, 'short', { min: 1, max: 2 })).toEqual({ min: 300, max: 450 })
  })

  it('未知档位回退默认值', () => {
    expect(resolveCharRange(presets, 'huge', { min: 500, max: 600 })).toEqual({ min: 500, max: 600 })
  })

  it('非法区间被修正', () => {
    const r = resolveCharRange({ bad: { min: 900, max: 100 } }, 'bad', { min: 1, max: 2 })
    expect(r.max).toBeGreaterThan(r.min)
  })
})
