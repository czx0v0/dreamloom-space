import { describe, expect, it } from 'vitest'
import { mockArchive, mockNarration } from '../../server/mock.js'
import { isLikelyRepeat, parseNarration } from '../../src/domain/scene'
import { evidenceIn } from '../../src/domain/validate'

const req = (action: string, summaries = '') => ({
  sections: { action, summaries },
  choiceCount: 3,
})

describe('mockNarration', () => {
  it('不同行动给出不同文本（否则连点掷骰子会复读）', () => {
    const a = parseNarration(mockNarration(req('开场'))).scene
    const b = parseNarration(mockNarration(req('掷骰：问下去'))).scene
    expect(isLikelyRepeat(a, b)).toBe(false)
  })

  it('同一输入是确定的（便于回归）', () => {
    expect(mockNarration(req('开场'))).toBe(mockNarration(req('开场')))
  })

  it('能解析出正文与选项', () => {
    const parsed = parseNarration(mockNarration(req('推门进去')))
    expect(parsed.scene.length).toBeGreaterThan(40)
    expect(parsed.choices).toHaveLength(3)
  })

  it('前情变化也会改变文本', () => {
    const a = parseNarration(mockNarration(req('问下去', ''))).scene
    const b = parseNarration(mockNarration(req('问下去', '- 第 1 幕：他进了客栈'))).scene
    expect(isLikelyRepeat(a, b)).toBe(false)
  })
})

describe('mockArchive', () => {
  const sceneText = '他推开门，雾涌进来。掌柜说：「你迟到了。」'

  it('产出的 evidence 都能通过子串校验', () => {
    const data = JSON.parse(mockArchive(sceneText))
    expect(data.ops.length).toBeGreaterThan(0)
    for (const op of data.ops) {
      expect(evidenceIn(op.evidence, sceneText)).toBe(true)
    }
  })

  it('坏样例确实是坏 JSON（用来验证修复路径）', () => {
    const bad = mockArchive(sceneText, { bad: true })
    expect(() => JSON.parse(bad)).toThrow()
  })
})

describe('mockNarration · 相邻幕不重复', () => {
  it('同一行动连推四幕，文本各不相同', () => {
    const texts = [0, 1, 2, 3].map((n) => {
      const summaries = Array.from({ length: n }, (_, i) => `- 第 ${i + 1} 幕：x`).join('\n')
      return parseNarration(mockNarration(req('问下去', summaries))).scene
    })
    for (let i = 1; i < texts.length; i++) {
      expect(isLikelyRepeat(texts[i - 1], texts[i])).toBe(false)
    }
  })
})
