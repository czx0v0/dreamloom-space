/**
 * 分块：把一幕正文切成可检索的块。
 *
 * 为什么以「幕」为基本单位而不是固定 token 窗口：
 *  - 与 beat 对齐，能精确引用「第 7 幕」
 *  - 幕是作者意义上的语义边界，切开它没有收益
 *  - 固定窗口会把一段对话从中间切断，丢失「谁说的」归属
 */

import type { Clue } from './types'

export interface Chunk {
  id: string
  spaceId: string
  sceneId: string
  /** 幕序 */
  index: number
  /** 长幕被切开时的序号，从 0 开始 */
  partIndex: number
  startChar: number
  endChar: number
  kind: 'narration' | 'dialogue'
  castIds: string[]
  placeIds: string[]
  charCount: number
  text: string
}

export interface ChunkOptions {
  maxChars: number
  overlapChars: number
}

const QUOTE_CHARS = /[「」“”"『』]/g

/** 引号密度高视为对话块：对话块更适合被"原话"类查询召回。 */
export function detectKind(text: string): 'narration' | 'dialogue' {
  if (!text) return 'narration'
  const quotes = (text.match(QUOTE_CHARS) ?? []).length
  return quotes / text.length > 0.012 ? 'dialogue' : 'narration'
}

interface RawSlice {
  text: string
  startChar: number
  endChar: number
}

/**
 * 按段落贪心打包，超长时切块并保留 overlap。
 * 段落本身比 maxChars 还长时，退化为按 maxChars 硬切（中文长句无空格，只能这样）。
 */
export function splitText(text: string, opts: ChunkOptions): RawSlice[] {
  const max = Math.max(120, opts.maxChars)
  const overlap = Math.min(Math.max(0, opts.overlapChars), Math.floor(max / 3))
  const src = text ?? ''
  if (!src.trim()) return []
  if (src.length <= max) return [{ text: src, startChar: 0, endChar: src.length }]

  const paragraphs: RawSlice[] = []
  let cursor = 0
  for (const piece of src.split(/(?<=\n)/)) {
    if (!piece) continue
    paragraphs.push({ text: piece, startChar: cursor, endChar: cursor + piece.length })
    cursor += piece.length
  }

  const out: RawSlice[] = []
  let buf = ''
  let bufStart = 0

  const flush = () => {
    if (!buf.trim()) return
    out.push({ text: buf, startChar: bufStart, endChar: bufStart + buf.length })
  }

  for (const p of paragraphs) {
    if (p.text.length > max) {
      flush()
      buf = ''
      let i = 0
      while (i < p.text.length) {
        const piece = p.text.slice(i, i + max)
        out.push({
          text: piece,
          startChar: p.startChar + i,
          endChar: p.startChar + i + piece.length,
        })
        i += Math.max(1, max - overlap)
      }
      bufStart = p.endChar
      continue
    }
    if (buf.length + p.text.length > max && buf) {
      flush()
      const tail = overlap > 0 ? buf.slice(-overlap) : ''
      buf = tail + p.text
      bufStart = p.startChar - tail.length
    } else {
      if (!buf) bufStart = p.startChar
      buf += p.text
    }
  }
  flush()

  return out.filter((s) => s.text.trim().length > 0)
}

export interface BuildChunksInput extends ChunkOptions {
  spaceId: string
  sceneId: string
  index: number
  text: string
  castIds: string[]
  placeIds: string[]
}

export function buildChunks(input: BuildChunksInput): Chunk[] {
  const slices = splitText(input.text, input)
  return slices.map((slice, partIndex) => ({
    id: `${input.sceneId}#${partIndex}`,
    spaceId: input.spaceId,
    sceneId: input.sceneId,
    index: input.index,
    partIndex,
    startChar: Math.max(0, slice.startChar),
    endChar: slice.endChar,
    kind: detectKind(slice.text),
    castIds: [...input.castIds],
    placeIds: [...input.placeIds],
    charCount: slice.text.replace(/\s/g, '').length,
    text: slice.text,
  }))
}

/** 把未收的伏笔也做成可检索的短卡片：这类短文本命中率最高。 */
export function clueCardText(clue: Clue): string {
  return `未收线索（第${clue.sceneId}）：${clue.text}`
}
