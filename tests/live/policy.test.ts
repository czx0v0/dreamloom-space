import { describe, expect, test } from 'vitest'
import { createPolicy } from './policy'

const choices = [
  { label: '先去码头问问昨晚的船' },
  { label: '留在客栈，等掌柜开口' },
  { label: '把信摊在桌上，直接问他' },
]

describe('playtest policy', () => {
  test('同一种子给出同一串决定', () => {
    const a = createPolicy(42)
    const b = createPolicy(42)
    const run = (rand: ReturnType<typeof createPolicy>) =>
      Array.from({ length: 20 }, () =>
        rand.decide({ index: 1, choices, mainGoal: '查清父亲死因' }),
      ).map((d) => d.text)
    expect(run(a)).toEqual(run(b))
  })

  test('顺主线时优先选与目标相关的选项', () => {
    const p = createPolicy(7)
    let follow = 0
    for (let i = 0; i < 200; i++) {
      const d = p.decide({ index: 2, choices, mainGoal: '查清父亲在码头死的真相' })
      if (d.why === 'follow') {
        follow++
        expect(d.text).toBe(choices[0].label)
      }
    }
    // 60% 上下，允许方差
    expect(follow).toBeGreaterThan(80)
  })

  test('没有选项时退化为自由行动，不会崩', () => {
    const p = createPolicy(1)
    const d = p.decide({ index: 0, choices: [], mainGoal: '' })
    expect(d.kind).toBe('free')
    expect(d.text.length).toBeGreaterThan(2)
  })

  test('三种策略都会出现，不会退化成单一分支', () => {
    const p = createPolicy(2026)
    const kinds = new Set<string>()
    for (let i = 0; i < 300; i++) {
      kinds.add(p.decide({ index: 3, choices, mainGoal: '查清码头上的死因' }).why)
    }
    expect(kinds.has('follow')).toBe(true)
    expect(kinds.has('explore')).toBe(true)
    expect(kinds.has('free')).toBe(true)
  })
})
