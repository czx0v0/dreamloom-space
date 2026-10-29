import { describe, expect, it } from 'vitest'
import {
  keywordCandidates,
  keywordScore,
  recall,
  recencyScore,
  scoreCandidate,
  tokenize,
  type RecallCandidate,
  type RecallOptions,
} from '../../src/domain/recall'

const baseOpts: RecallOptions = {
  weights: { cosine: 0.7, recency: 0.2, entity: 0.1 },
  minScore: 0.32,
  topK: 6,
  keep: 4,
  currentIndex: 20,
  excludeSceneIds: [],
  entityIds: [],
  budgetChars: 400,
}

function cand(over: Partial<RecallCandidate> = {}): RecallCandidate {
  return {
    sceneId: 'sc_1',
    index: 1,
    partIndex: 0,
    text: '他收到一封信，信上只有三个字。',
    cosine: 0.8,
    castIds: [],
    placeIds: [],
    ...over,
  }
}

describe('recencyScore', () => {
  it('越近越高', () => {
    expect(recencyScore(20, 19)).toBeGreaterThan(recencyScore(20, 2))
    expect(recencyScore(20, 20)).toBe(1)
  })

  it('首幕没有近因可言', () => {
    expect(recencyScore(0, 0)).toBe(0)
  })
})

describe('scoreCandidate', () => {
  it('纯余弦之外还会被近因拉高', () => {
    const old = cand({ index: 1 })
    const recent = cand({ index: 19 })
    expect(scoreCandidate(recent, baseOpts)).toBeGreaterThan(scoreCandidate(old, baseOpts))
  })

  it('实体命中加分', () => {
    const plain = cand({ castIds: [] })
    const hit = cand({ castIds: ['ch_1'] })
    const opts = { ...baseOpts, entityIds: ['ch_1'] }
    expect(scoreCandidate(hit, opts)).toBeGreaterThan(scoreCandidate(plain, opts))
  })
})

describe('recall', () => {
  it('已在上下文里的最近幕不重复召回', () => {
    const out = recall(
      [cand({ sceneId: 'sc_19', index: 19, cosine: 0.99 })],
      { ...baseOpts, excludeSceneIds: ['sc_19'] },
    )
    expect(out).toHaveLength(0)
  })

  it('低于阈值的不召回', () => {
    const out = recall([cand({ cosine: 0.05, index: 19 })], baseOpts)
    expect(out).toHaveLength(0)
  })

  it('同一幕的多个块合并成一段', () => {
    const out = recall(
      [
        cand({ sceneId: 'sc_3', index: 3, partIndex: 0, text: '前半段', cosine: 0.9 }),
        cand({ sceneId: 'sc_3', index: 3, partIndex: 1, text: '后半段', cosine: 0.85 }),
      ],
      baseOpts,
    )
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('前半段 … 后半段')
  })

  it('按 keep 与字符预算截断', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      cand({
        sceneId: `sc_${i + 1}`,
        index: i + 1,
        text: '字'.repeat(180),
        cosine: 0.9,
      }),
    )
    const out = recall(many, { ...baseOpts, keep: 4, budgetChars: 400 })
    expect(out.length).toBeGreaterThan(0)
    const total = out.reduce((n, r) => n + r.text.length, 0)
    expect(total).toBeLessThanOrEqual(401)
  })

  it('结果按分数从高到低', () => {
    const out = recall(
      [
        cand({ sceneId: 'sc_1', index: 18, cosine: 0.5 }),
        cand({ sceneId: 'sc_2', index: 19, cosine: 0.95 }),
      ],
      baseOpts,
    )
    expect(out[0].score).toBeGreaterThanOrEqual(out[1].score)
  })
})

describe('keyword 召回', () => {
  it('tokenize 切中文 2-gram 与英文词', () => {
    const terms = tokenize('那封信 letter')
    expect(terms).toContain('那封')
    expect(terms).toContain('封信')
    expect(terms).toContain('letter')
  })

  it('关键词命中得分高于不相关文本', () => {
    const doc = '他收到一封信，信上只有三个字。'
    expect(keywordScore('那封信', doc)).toBeGreaterThan(0)
    expect(keywordScore('无人机航拍', doc)).toBe(0)
  })

  it('keywordCandidates 过滤零分', () => {
    const docs = [
      { sceneId: 'sc_1', index: 1, text: '他收到一封信。' },
      { sceneId: 'sc_2', index: 2, text: '码头起雾了。' },
    ]
    const out = keywordCandidates('信', docs)
    expect(out.map((c) => c.sceneId)).toEqual(['sc_1'])
  })

  it('无模型时整条链路仍可用', () => {
    const docs = [
      { sceneId: 'sc_4', index: 4, text: '那封信被塞进了抽屉最里面。' },
      { sceneId: 'sc_19', index: 19, text: '今天什么也没发生。' },
    ]
    const out = recall(keywordCandidates('那封信', docs), baseOpts)
    expect(out).toHaveLength(1)
    expect(out[0].sceneId).toBe('sc_4')
  })
})
