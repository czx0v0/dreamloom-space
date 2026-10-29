import { describe, expect, it } from 'vitest'
import { createSceneStream } from '../../src/domain/stream'

/** 把整段当成一次增量推入，再 flush。 */
function once(chunks: string[]): string {
  const stream = createSceneStream()
  let out = ''
  for (const chunk of chunks) out += stream.push(chunk)
  return out + stream.flush()
}

/** 逐字符推入，模拟最坏的切分。 */
function perChar(text: string): string {
  return once([...text])
}

describe('createSceneStream', () => {
  it('剥掉 <scene> 开标签', () => {
    expect(once(['<scene>', '雾漫上来。'])).toBe('雾漫上来。')
  })

  it('在 <choices> 处停止，选项不会进正文', () => {
    expect(once(['<scene>雾漫上来。<choices>1. 走\n2. 留</choices>'])).toBe('雾漫上来。')
  })

  it('在 </scene> 处停止', () => {
    expect(once(['<scene>雾漫上来。</scene><choices>'])).toBe('雾漫上来。')
  })

  it('标签被切成两半也能正确识别（逐字符）', () => {
    expect(perChar('<scene>雾漫上来。')).toBe('雾漫上来。')
  })

  it('开头就有正文时不会丢掉内容', () => {
    const out = perChar('<scene>林昭推开门，雾涌进来。')
    expect(out).toBe('林昭推开门，雾涌进来。')
  })

  it('模型完全不写 <scene> 时也能出文（不能一直憋着）', () => {
    const long = '雾从门缝里挤进来。'.repeat(30)
    expect(once([long])).toContain('雾从门缝里挤进来。')
  })

  it('短文本且无标签：靠 flush 兜底吐出来', () => {
    expect(once(['雾漫上来。'])).toBe('雾漫上来。')
  })

  it('流结束后不再接受输出', () => {
    const stream = createSceneStream()
    stream.push('<scene>雾漫上来。')
    stream.flush()
    expect(stream.push('更多的字')).toBe('')
  })

  it('分段推入拼起来等于一次性推入', () => {
    const text = '<scene>甲。乙。丙。</scene><choices>1. 去</choices>'
    expect(once([text.slice(0, 5), text.slice(5, 12), text.slice(12)])).toBe('甲。乙。丙。')
  })

  it('正文里出现尖括号但不是标签时不该误伤', () => {
    expect(once(['<scene>他说：「<不是标签>」</scene>'])).toContain('「')
  })
})
