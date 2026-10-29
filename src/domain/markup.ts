/**
 * 正文标记解析：把模型输出的一段文本切成可直接渲染的块与片段。
 *
 * 纯函数、无 DOM 依赖，因此可以被单测覆盖。
 *
 * 为什么不用 Markdown 库：
 *  - 只需要「分段 / 对白 / 强调 / 实体」四件事，库的体积和 XSS 面都不划算；
 *  - 我们**不接受任何 HTML**，输出是结构化片段，由 React 渲染（永不 innerHTML）。
 */

export type MentionKind = 'cast' | 'place'

/** 参与实体识别的条目。只取 id / name / aliases，不依赖完整类型。 */
export interface MentionRef {
  id: string
  name: string
  aliases?: string[]
}

export interface MentionContext {
  cast: MentionRef[]
  places: MentionRef[]
  /** 单块最多标记多少个实体，避免满屏可点词 */
  maxMentions?: number
}

export interface Segment {
  text: string
  kind: 'plain' | 'cast' | 'place'
  /** kind 为 cast / place 时的实体 id */
  id?: string
  /** 位于一对引号之内 */
  dialog: boolean
  /** 位于 **强调** / *斜体* 之内。与 kind 正交：`**林昭**` 既是实体也是强调。 */
  emph: boolean
}

export interface Block {
  segments: Segment[]
  /** 整块都在引号里（用于段落级样式） */
  dialog: boolean
}

/** 中英文引号配对。顺序不重要：扫描时逐个尝试起始符。 */
const QUOTE_PAIRS: Array<[string, string]> = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['"', '"'],
  ['‘', '’'],
]

const MAX_MENTIONS_DEFAULT = 12

/**
 * 剥掉模型的结构标签。
 *
 * 这一层是**兜底**，不是主路径：流式有 `createSceneStream`、落库前有 `parseNarration`。
 * 但显示层不能信任上游——旧存档可能是更早的版本写进去的，流式也可能有漏网的增量。
 * 一旦漏出来，用户看到的就是正文里夹着 `<scene>`，非常刺眼。
 */
export function sanitizeNarration(raw: string): string {
  let text = (raw ?? '').replace(/<\/?scene>/g, '')
  // <choices> 之后全是选项原文，正文到此为止
  const cut = text.indexOf('<choices>')
  if (cut >= 0) text = text.slice(0, cut)
  return text
}

/**
 * 按行切块。
 *
 * 模型输出中文小说时几乎总是一段一行，所以**单个换行就分段**：
 * 之前用 `<p>{text}</p>` 直接把换行吞成空格，整幕挤成一坨，这是最明显的渲染缺陷。
 * 同时清掉模型偶尔带的 Markdown 标题记号与分隔线。
 */
export function splitBlocks(raw: string): string[] {
  return sanitizeNarration(raw)
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((line) => line.replace(/^\s*#{1,6}\s+/, '').trim())
    .filter((line) => line.length > 0 && !/^([-*_]\s*){3,}$/.test(line))
}

/** 在这一段里找出所有实体提及的区间，长名优先，重叠不重复占位。 */
function findMentions(
  text: string,
  ctx: MentionContext,
): Array<{ start: number; end: number; kind: MentionKind; id: string }> {
  const limit = ctx.maxMentions ?? MAX_MENTIONS_DEFAULT
  if (text.length < 2) return []

  const dict: Array<{ name: string; kind: MentionKind; id: string }> = []
  for (const c of ctx.cast) {
    for (const name of [c.name, ...(c.aliases ?? [])]) {
      // 单字名一律不标：中文里「林」「王」这种既是姓也是普通词，误标率极高
      if (name && name.trim().length >= 2) dict.push({ name: name.trim(), kind: 'cast', id: c.id })
    }
  }
  for (const p of ctx.places) {
    if (p.name && p.name.trim().length >= 2) dict.push({ name: p.name.trim(), kind: 'place', id: p.id })
  }
  if (!dict.length) return []

  // 长名优先：「林昭昭」要先于「林昭」被匹配到，否则长名永远命不中
  dict.sort((a, b) => b.name.length - a.name.length)

  const taken = new Uint8Array(text.length)
  const hits: Array<{ start: number; end: number; kind: MentionKind; id: string }> = []

  for (const entry of dict) {
    let from = 0
    while (hits.length < limit) {
      const at = text.indexOf(entry.name, from)
      if (at < 0) break
      from = at + 1
      const end = at + entry.name.length
      let free = true
      for (let i = at; i < end; i++) {
        if (taken[i]) {
          free = false
          break
        }
      }
      if (!free) continue
      for (let i = at; i < end; i++) taken[i] = 1
      hits.push({ start: at, end, kind: entry.kind, id: entry.id })
    }
  }

  return hits.sort((a, b) => a.start - b.start)
}

/** 把一段纯文本按实体提及切成分片（不做引号 / 强调处理）。 */
function splitByMentions(
  text: string,
  ctx: MentionContext,
  dialog: boolean,
  emph: boolean,
): Segment[] {
  const hits = findMentions(text, ctx)
  if (!hits.length) return [{ text, kind: 'plain', dialog, emph }]

  const out: Segment[] = []
  let cursor = 0
  for (const hit of hits) {
    if (hit.start > cursor) {
      out.push({ text: text.slice(cursor, hit.start), kind: 'plain', dialog, emph })
    }
    out.push({ text: text.slice(hit.start, hit.end), kind: hit.kind, id: hit.id, dialog, emph })
    cursor = hit.end
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), kind: 'plain', dialog, emph })
  return out
}

/**
 * 解析一行的行内标记：引号对白 + `**强调**` / `*斜体*`，再在纯文本片段上找实体。
 *
 * 顺序是先切标记、再切实体：实体名是字面匹配，不会跨越标点，所以不会被标记切坏。
 * 反过来先切实体的话，`**林昭**` 这种写法会让强调标记落到实体片段里而失效。
 */
function parseInline(
  text: string,
  ctx: MentionContext,
  dialog: boolean,
  emph = false,
): Segment[] {
  const out: Segment[] = []
  let buffer = ''
  let i = 0

  const flush = () => {
    if (buffer) {
      out.push(...splitByMentions(buffer, ctx, dialog, emph))
      buffer = ''
    }
  }

  while (i < text.length) {
    const ch = text[i]

    // 强调：**加粗** / *斜体*
    if (ch === '*') {
      const double = text[i + 1] === '*'
      const marker = double ? '**' : '*'
      const close = text.indexOf(marker, i + marker.length)
      if (close > i + marker.length) {
        flush()
        const inner = text.slice(i + marker.length, close)
        // 强调里的人名照样要能点：先按实体切，再整体标 emph
        out.push(...splitByMentions(inner, ctx, dialog, true))
        i = close + marker.length
        continue
      }
      buffer += ch
      i++
      continue
    }

    // 引号对白：整段包进 dialog 标记
    const pair = QUOTE_PAIRS.find(([open]) => ch === open)
    if (pair) {
      const close = text.indexOf(pair[1], i + 1)
      if (close > i) {
        flush()
        // 引号本身保留在文本里：去掉会让读者分不清"这句是谁说的"
        out.push({ text: pair[0], kind: 'plain', dialog: true, emph })
        out.push(...parseInline(text.slice(i + 1, close), ctx, true, emph))
        out.push({ text: pair[1], kind: 'plain', dialog: true, emph })
        i = close + 1
        continue
      }
    }

    buffer += ch
    i++
  }

  flush()
  return out
}

/** 把整段正文解析成可渲染的块列表。 */
export function segmentText(raw: string, ctx: MentionContext): Block[] {
  return splitBlocks(raw).map((line) => {
    const segments = parseInline(line, ctx, false)
    const dialog = segments.length > 0 && segments.every((s) => s.dialog)
    return { segments, dialog }
  })
}

/** 从正文里唯一提取出提及过的实体 id（按首次出现顺序），供 UI 做「本幕涉及」。 */
export function mentionedIds(blocks: Block[]): { cast: string[]; places: string[] } {
  const cast: string[] = []
  const places: string[] = []
  for (const block of blocks) {
    for (const seg of block.segments) {
      if (seg.kind === 'cast' && seg.id && !cast.includes(seg.id)) cast.push(seg.id)
      if (seg.kind === 'place' && seg.id && !places.includes(seg.id)) places.push(seg.id)
    }
  }
  return { cast, places }
}

/** 段落的纯文本（去掉标记），用于导出与摘要。 */
export function plainText(blocks: Block[]): string {
  return blocks.map((b) => b.segments.map((s) => s.text).join('')).join('\n')
}
