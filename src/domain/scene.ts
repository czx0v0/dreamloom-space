/**
 * 叙事输出的解析与场景状态机。
 *
 * 协议是双标签而不是 JSON：
 *  - 流式可以边收边渲染，不用等完整对象
 *  - 中文换行不会被 \n 转义破坏
 *  - 弱模型几乎写不坏两个闭合标签；写坏一次 JSON 就整幕丢失
 * 解析失败绝不允许卡住玩家 —— 所有兜底都在这里。
 */

import type { Choice, SceneStatus } from './types'

const OPEN = '<scene>'
const CLOSE = '</scene>'
const CHOICES_OPEN = '<choices>'
const CHOICES_CLOSE = '</choices>'

/** 流式过程中，从累积的原始文本里取出「当前可以显示」的正文。 */
export function visibleSceneText(raw: string): string {
  if (!raw) return ''
  const open = raw.indexOf(OPEN)
  if (open >= 0) {
    let rest = raw.slice(open + OPEN.length)
    const close = rest.indexOf(CLOSE)
    if (close >= 0) {
      rest = rest.slice(0, close)
    } else {
      // 尾部可能正在输出 </sc 这类残片，先去掉，避免闪一下 "</sc"
      const tail = rest.lastIndexOf('<')
      if (tail >= 0) {
        const fragment = rest.slice(tail)
        if (CLOSE.startsWith(fragment)) rest = rest.slice(0, tail)
      }
    }
    return rest.replace(/^\r?\n/, '')
  }

  // 还没看到 <scene>：如果开头明显在吐标签，先不显示
  const lead = raw.replace(/^\s+/, '')
  if (lead.startsWith('<') && !lead.includes('>')) return ''
  if (lead.startsWith(OPEN.slice(0, 5)) && !lead.includes('>')) return ''
  // 模型没按格式来，直接把全文当正文（长度足够才判定，避免早期抖动）
  if (raw.includes('<') || raw.length < 20) return ''
  return raw
}

/**
 * 选项意图：固定四类，不做自由发挥。
 *
 * 有标签的选项玩家能一眼看出"这是在做什么"，也让 prompt 有东西可约束；
 * 标签不在白名单里就整条当文案（宁可少一个标签，不要把 `[重要]` 这种误当意图）。
 */
export const CHOICE_INTENTS = ['追问', '行动', '观察', '离开'] as const
export type ChoiceIntent = (typeof CHOICE_INTENTS)[number]

const INTENT_PREFIX = /^\s*[\[【]\s*([^\]】]{1,4})\s*[\]】]\s*/

function parseChoiceLines(block: string, limit: number): Choice[] {
  const out: Choice[] = []
  for (const line of block.split(/\r?\n/)) {
    let cleaned = line
      .replace(/^\s*(?:\d+\s*[.、)．]|[-*•·])\s*/, '')
      .replace(/^\s*选项\s*\d+\s*[:：]\s*/, '')
      .trim()
    if (!cleaned) continue

    const choice = parseChoiceLabel(cleaned)
    if (!choice) continue
    out.push(choice)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 单条选项文本 → Choice。
 *
 * 服务端也会解析 `<choices>`（用于流结束时补齐），它给的是**带标签的原始行**；
 * 客户端必须走同一个函数，否则一条选项在两条路径上会得到两种样子。
 */
export function parseChoiceLabel(line: string): Choice | null {
  let cleaned = (line ?? '').trim()
  if (!cleaned) return null

  let intent: ChoiceIntent | undefined
  const tagged = INTENT_PREFIX.exec(cleaned)
  if (tagged) {
    const tag = tagged[1].trim()
    if ((CHOICE_INTENTS as readonly string[]).includes(tag)) {
      intent = tag as ChoiceIntent
      cleaned = cleaned.slice(tagged[0].length).trim()
    }
  }
  if (!cleaned) return null

  const label = cleaned.length > 60 ? cleaned.slice(0, 60) : cleaned
  return intent ? { label, intent } : { label }
}

export interface ParsedNarration {
  scene: string
  choices: Choice[]
  hadSceneTag: boolean
  hadChoicesTag: boolean
}

export function parseNarration(raw: string, choiceLimit = 3): ParsedNarration {
  const hadSceneTag = raw.includes(OPEN)
  const hadChoicesTag = raw.includes(CHOICES_OPEN)

  let scene = visibleSceneText(raw)
  scene = scene.replace(CLOSE, '').trim()

  let choices: Choice[] = []
  if (hadChoicesTag) {
    const start = raw.indexOf(CHOICES_OPEN) + CHOICES_OPEN.length
    const endIdx = raw.indexOf(CHOICES_CLOSE, start)
    const block = endIdx >= 0 ? raw.slice(start, endIdx) : raw.slice(start)
    choices = parseChoiceLines(block, choiceLimit)
  }

  // 正文里若误把 choices 段算进来（模型没闭合 scene 标签），兜底剔除
  const cIdx = scene.indexOf(CHOICES_OPEN)
  if (cIdx >= 0) scene = scene.slice(0, cIdx).trim()

  return { scene, choices, hadSceneTag, hadChoicesTag }
}

/** 解析不出选项时的兜底：给两个方向 + 一个「静观其变」，绝不空着。 */
export function fallbackChoices(beat: string | null, count: number): Choice[] {
  const n = Math.max(1, Math.min(5, count))
  // 兜底选项也带意图：模型漏写 <choices> 时，界面不该突然从"有标签"退回"光秃秃"
  const pool: Choice[] = [
    { label: '顺着这条线往下追', intent: '追问' },
    { label: beat ? `换个角度：${beat.slice(0, 18)}` : '换个角度看看', intent: '行动' },
    { label: '静观其变，先看看周围', intent: '观察' },
    { label: '直接离开这里', intent: '离开' },
    { label: '回头确认刚才的细节', intent: '观察' },
  ]
  return pool.slice(0, n)
}

const TRANSITIONS: Record<SceneStatus, SceneStatus[]> = {
  streaming: ['committed', 'aborted'],
  committed: ['orphan'],
  aborted: [],
  orphan: [],
}

export function canTransition(from: SceneStatus, to: SceneStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * 判断这一段是否和上一段几乎一样。
 *
 * 真实原因有两类：模型在低温度下复读，或者同一 action 被重复提交（比如连点随机选择）。
 * 只比较前 120 字的归一化前缀：足够抓住"整段照抄"，又不会误伤正常的呼应。
 */
export function isLikelyRepeat(previous: string, next: string): boolean {
  const norm = (s: string) => (s ?? '').replace(/[\s\u3000，。！？；：、…—""''《》「」『』（）()\[\]{}·,.;:!?\-]/g, '')
  const a = norm(previous)
  const b = norm(next)
  if (!a || !b) return false
  if (a === b) return true
  const n = Math.min(a.length, b.length, 120)
  if (n < 40) return false
  return a.slice(0, n) === b.slice(0, n)
}

/** 统计正文字数（不含空白）。 */
export function countChars(text: string): number {
  return (text ?? '').replace(/\s/g, '').length
}
