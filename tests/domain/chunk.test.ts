import { describe, expect, it } from 'vitest'
import { buildChunks, detectKind, splitText } from '../../src/domain/chunk'

const opts = { maxChars: 200, overlapChars: 40 }

describe('splitText', () => {
  it('短文本不切', () => {
    const slices = splitText('他推开门。', opts)
    expect(slices).toHaveLength(1)
    expect(slices[0]).toMatchObject({ startChar: 0 })
  })

  it('长文本切成多块且每块不超过上限', () => {
    const text = `${'第一段内容'.repeat(30)}\n${'第二段内容'.repeat(30)}\n${'第三段内容'.repeat(30)}`
    const slices = splitText(text, opts)
    expect(slices.length).toBeGreaterThan(1)
    for (const s of slices) expect(s.text.length).toBeLessThanOrEqual(200)
  })

  it('相邻块有重叠，避免切断对话', () => {
    const text = `${'甲'.repeat(150)}\n${'乙'.repeat(150)}`
    const slices = splitText(text, opts)
    expect(slices.length).toBe(2)
    expect(slices[1].text.startsWith('甲')).toBe(true)
  })

  it('单段超长时退化为硬切，仍然覆盖全文', () => {
    const text = '丙'.repeat(500)
    const slices = splitText(text, opts)
    const covered = slices.reduce((n, s) => n + s.text.length, 0)
    expect(slices.length).toBeGreaterThan(2)
    expect(covered).toBeGreaterThanOrEqual(500)
  })

  it('startChar 单调递增且不越界', () => {
    const text = `${'甲'.repeat(100)}\n${'乙'.repeat(100)}\n${'丙'.repeat(100)}`
    const slices = splitText(text, opts)
    let last = -1
    for (const s of slices) {
      expect(s.startChar).toBeGreaterThanOrEqual(last)
      expect(s.endChar).toBeLessThanOrEqual(text.length)
      last = s.startChar
    }
  })

  it('空文本返回空数组', () => {
    expect(splitText('   ', opts)).toHaveLength(0)
  })
})

describe('detectKind', () => {
  it('引号密度高视为对话', () => {
    expect(detectKind('「你来了。」「我来了。」「坐。」')).toBe('dialogue')
  })

  it('纯叙述', () => {
    expect(detectKind('雾从码头漫上来，把整条街浸成灰色。')).toBe('narration')
  })
})

describe('buildChunks', () => {
  it('产出稳定 id 并带上实体归属', () => {
    const chunks = buildChunks({
      ...opts,
      spaceId: 'sp_1',
      sceneId: 'sc_7',
      index: 7,
      text: '他推开门，雾涌进来。',
      castIds: ['ch_1'],
      placeIds: ['pl_2'],
    })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      id: 'sc_7#0',
      sceneId: 'sc_7',
      index: 7,
      partIndex: 0,
      castIds: ['ch_1'],
      placeIds: ['pl_2'],
    })
  })

  it('长幕切成多块且 partIndex 连续', () => {
    const chunks = buildChunks({
      ...opts,
      spaceId: 'sp_1',
      sceneId: 'sc_8',
      index: 8,
      text: `${'甲'.repeat(150)}\n${'乙'.repeat(150)}`,
      castIds: [],
      placeIds: [],
    })
    expect(chunks.map((c) => c.partIndex)).toEqual([0, 1])
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length)
  })
})
