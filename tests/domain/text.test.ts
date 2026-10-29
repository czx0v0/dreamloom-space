import { describe, expect, it } from 'vitest'
import { sanitizeUserText, textSimilarity } from '../../src/domain/text'

describe('sanitizeUserText', () => {
  it('截断到上限（前端 maxLength 不可信）', () => {
    expect(sanitizeUserText('甲'.repeat(300), 200)).toHaveLength(200)
  })

  it('去掉零宽字符与控制字符', () => {
    expect(sanitizeUserText('雾\u200b漫上\u200f来\ufeff。')).toBe('雾漫上来。')
  })

  it('统一换行并压掉连续空行', () => {
    expect(sanitizeUserText('甲\r\n\r\n\r\n乙')).toBe('甲\n\n乙')
  })

  it('只有空白等于空串', () => {
    expect(sanitizeUserText('   \n\t ')).toBe('')
  })

  it('正常句子原样保留（"忽略"这类词不该被过滤）', () => {
    const s = '他忽略了对方的建议，径直走了。'
    expect(sanitizeUserText(s)).toBe(s)
  })
})

describe('textSimilarity', () => {
  it('完全相同为 1', () => {
    expect(textSimilarity('提货单被海关扣下', '提货单被海关扣下')).toBe(1)
  })

  it('同一件事的两种说法判为高度相似', () => {
    const score = textSimilarity('三号仓库的提货单被海关扣下', '海关扣了三号仓库的提货单')
    expect(score).toBeGreaterThan(0.6)
  })

  it('包含关系给高相似度', () => {
    expect(textSimilarity('提货单被海关扣下', '提货单被海关扣下要查旧账')).toBe(0.9)
  })

  it('不相关的事相似度低', () => {
    expect(textSimilarity('提货单被海关扣下', '阿棠喜欢在雨后晒被子')).toBeLessThan(0.3)
  })

  it('空值不产生负数或 NaN', () => {
    expect(textSimilarity('', '任意')).toBe(0)
  })
})

describe('textSimilarity · 不能误伤的两组', () => {
  it('结构相同但关键名词不同，不该判为同一件事', () => {
    // 这两条 Jaccard 有 0.56，用 Jaccard 会合并，等于把两件事缝在一起
    const score = textSimilarity('林昭在码头等他', '林昭在仓库等他')
    expect(score).toBeLessThan(0.8)
  })

  it('换语序的同一件事，仍要抓住', () => {
    expect(textSimilarity('周慕之那夜去哪了', '那夜周慕之去了哪儿')).toBeGreaterThan(0.8)
  })

  it('不同详略的同一件事，也要抓住', () => {
    const score = textSimilarity('三号仓库的提货单被海关扣下，说要查旧账', '海关扣了三号仓库的提货单')
    expect(score).toBeGreaterThan(0.8)
  })
})
