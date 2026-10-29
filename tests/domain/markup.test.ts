import { describe, expect, it } from 'vitest'
import {
  mentionedIds,
  plainText,
  sanitizeNarration,
  segmentText,
  splitBlocks,
  type MentionContext,
} from '../../src/domain/markup'

const ctx: MentionContext = {
  cast: [
    { id: 'ch_1', name: '林昭', aliases: ['林记者'] },
    { id: 'ch_2', name: '掌柜' },
    { id: 'ch_3', name: '林昭昭' },
  ],
  places: [{ id: 'pl_1', name: '同福客栈' }],
}

const flat = (raw: string, c: MentionContext = ctx) =>
  segmentText(raw, c)
    .map((b) => b.segments.map((s) => s.text).join(''))
    .join('\n')

describe('splitBlocks', () => {
  it('单个换行也分段（否则整幕挤成一坨）', () => {
    expect(splitBlocks('第一段\n第二段')).toEqual(['第一段', '第二段'])
  })

  it('多个连续换行不多出空块', () => {
    expect(splitBlocks('甲\n\n\n乙\n')).toEqual(['甲', '乙'])
  })

  it('剥掉模型误加的 Markdown 标题记号', () => {
    expect(splitBlocks('## 第一幕\n正文')).toEqual(['第一幕', '正文'])
  })

  it('跳过分隔线', () => {
    expect(splitBlocks('甲\n---\n乙')).toEqual(['甲', '乙'])
  })

  it('兼容 CRLF 与首尾空白', () => {
    expect(splitBlocks('  甲  \r\n乙\t')).toEqual(['甲', '乙'])
  })
})

describe('segmentText · 对白', () => {
  it('引号内容标记为 dialog，引号本身保留', () => {
    const blocks = segmentText('「你迟到了。」他说。', ctx)
    expect(blocks).toHaveLength(1)
    const segs = blocks[0].segments
    expect(segs.map((s) => s.text).join('')).toBe('「你迟到了。」他说。')
    const quoted = segs.filter((s) => s.dialog && s.kind === 'plain')
    expect(quoted.map((s) => s.text)).toContain('你迟到了。')
    expect(blocks[0].dialog).toBe(false)
  })

  it('整块都是对白时 block.dialog 为真', () => {
    const blocks = segmentText('「你迟到了。」', ctx)
    expect(blocks[0].dialog).toBe(true)
  })

  it('支持中文书名式双引号与英文引号', () => {
    for (const raw of ['「好。」', '“好。”', '"好。"']) {
      const blocks = segmentText(raw, ctx)
      expect(blocks[0].segments.some((s) => s.dialog && s.text === '好。')).toBe(true)
    }
  })

  it('未闭合的引号按普通文本处理，不吞掉后半句', () => {
    expect(flat('「你迟到了。他说。')).toBe('「你迟到了。他说。')
  })

  it('对白里出现的实体仍然可点', () => {
    const blocks = segmentText('「林昭，你来晚了。」', ctx)
    const hit = blocks[0].segments.find((s) => s.kind === 'cast')
    expect(hit).toMatchObject({ text: '林昭', id: 'ch_1', dialog: true })
  })
})

describe('segmentText · 强调', () => {
  it('**粗体** 标记为 emph', () => {
    const blocks = segmentText('他终于**推开门**了。', ctx)
    const hit = blocks[0].segments.find((s) => s.emph)
    expect(hit?.text).toBe('推开门')
    expect(hit?.kind).toBe('plain')
    // 标记本身不进文本
    expect(blocks[0].segments.map((s) => s.text).join('')).toBe('他终于推开门了。')
  })

  it('单星号斜体同样处理', () => {
    const blocks = segmentText('雾*很低*。', ctx)
    expect(blocks[0].segments.find((s) => s.emph)?.text).toBe('很低')
  })

  it('未闭合的星号保留原样', () => {
    expect(flat('雾**很低。')).toBe('雾**很低。')
  })

  it('粗体里的人名照样可点（emph 与 kind 正交）', () => {
    const blocks = segmentText('**林昭**抬头。', ctx)
    const hit = blocks[0].segments.find((s) => s.kind === 'cast')
    expect(hit).toMatchObject({ text: '林昭', id: 'ch_1', emph: true })
  })
})

describe('segmentText · 实体提及', () => {
  it('角色名标成 cast 并带 id', () => {
    const blocks = segmentText('林昭推门进来。', ctx)
    const hit = blocks[0].segments.find((s) => s.kind === 'cast')
    expect(hit).toMatchObject({ text: '林昭', id: 'ch_1' })
  })

  it('地点标成 place', () => {
    const blocks = segmentText('他走进同福客栈。', ctx)
    expect(blocks[0].segments.find((s) => s.kind === 'place')).toMatchObject({
      text: '同福客栈',
      id: 'pl_1',
    })
  })

  it('长名优先：「林昭昭」不会被切成「林昭」+「昭」', () => {
    const blocks = segmentText('林昭昭站在门口。', ctx)
    const hits = blocks[0].segments.filter((s) => s.kind === 'cast')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ text: '林昭昭', id: 'ch_3' })
  })

  it('别名同样可点', () => {
    const blocks = segmentText('林记者推门进来。', ctx)
    expect(blocks[0].segments.find((s) => s.kind === 'cast')?.id).toBe('ch_1')
  })

  it('单字提名不标（误伤严重）', () => {
    const single: MentionContext = { cast: [{ id: 'ch_9', name: '林' }], places: [] }
    const blocks = segmentText('林子里很静。', single)
    expect(blocks[0].segments.every((s) => s.kind === 'plain')).toBe(true)
  })

  it('同一实体多次出现都标，但受上限约束', () => {
    const raw = '林昭。'.repeat(20)
    const blocks = segmentText(raw, { ...ctx, maxMentions: 3 })
    expect(blocks.flatMap((b) => b.segments).filter((s) => s.kind === 'cast')).toHaveLength(3)
  })

  it('没有 cast/places 时全部按普通文本处理', () => {
    const blocks = segmentText('林昭推门进来。', { cast: [], places: [] })
    expect(blocks[0].segments).toEqual([
      { text: '林昭推门进来。', kind: 'plain', dialog: false, emph: false },
    ])
  })
})

describe('辅助函数', () => {
  it('mentionedIds 去重并按首次出现顺序', () => {
    const blocks = segmentText('掌柜看见林昭，又看见林昭。', ctx)
    expect(mentionedIds(blocks).cast).toEqual(['ch_2', 'ch_1'])
  })

  it('plainText 还原成不带标记的纯文本', () => {
    const blocks = segmentText('他**推门**，走进同福客栈。\n「林昭。」', ctx)
    expect(plainText(blocks)).toBe('他推门，走进同福客栈。\n「林昭。」')
  })

  it('空文本得到空数组，不产生空块', () => {
    expect(segmentText('', ctx)).toEqual([])
    expect(segmentText('   \n\n ', ctx)).toEqual([])
  })
})

describe('sanitizeNarration · 脏数据免疫', () => {
  it('剥掉 <scene> 与 </scene>', () => {
    expect(sanitizeNarration('<scene>雾漫上来。</scene>')).toBe('雾漫上来。')
  })

  it('从 <choices> 起截断', () => {
    expect(sanitizeNarration('<scene>雾漫上来。<choices>1. 走</choices>')).toBe('雾漫上来。')
  })

  it('没有标签时原样返回', () => {
    expect(sanitizeNarration('雾漫上来。')).toBe('雾漫上来。')
  })

  it('标签出现在中间也剥掉（模型重复写标签）', () => {
    expect(sanitizeNarration('甲。<scene>乙。</scene>丙。')).toBe('甲。乙。丙。')
  })

  it('segmentText 出来的块里不含任何标签', () => {
    const blocks = segmentText('<scene>林昭推门。</scene><choices>1. 走</choices>', ctx)
    const text = blocks.map((b) => b.segments.map((s) => s.text).join('')).join('\n')
    expect(text).toBe('林昭推门。')
    expect(text).not.toContain('<')
  })
})
