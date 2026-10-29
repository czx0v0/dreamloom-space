/**
 * 线索的两段式：已知 + 待答。
 *
 * 为什么不是一句话：实测里线索写成了"周慕之每回上楼前都在柜台前问雾几时散"——
 * 这是一条**已查到的信息**，玩家读完不会产生"我想知道答案"的冲动。
 * 真正的悬念必须是一个还没有答案的问题；而"为什么值得追"要靠已知部分撑住。
 *
 * 所以每条线索存两段：known（已经确定的事）+ unknown（还没答的问题）。
 * `text` 保留为 unknown 的别名，只为兼容旧代码与导出，不再作为独立语义。
 */

export interface CluePair {
  known: string
  unknown: string
}

/** 疑问词分强弱：强疑问词单独出现就够，弱疑问词（谁/什么/哪）只在短句里可信。 */
const STRONG = /到底|究竟|是否|是不是|有没有|为什么|为何|怎么|如何/
const WH = /谁|什么|哪/
const ENDING = /[？?]\s*$/

/** 太短的"是谁？"不算真问题：它没有指向任何具体的东西。 */
const MIN_UNKNOWN = 5
const MAX_LEN = 60
/** 没有问号时，超过这个长度基本就是叙述句了 */
const SHORT_ENOUGH = 26

export function looksLikeQuestion(text: string): boolean {
  const t = (text ?? '').trim()
  if (t.length < MIN_UNKNOWN || t.length > MAX_LEN) return false
  if (ENDING.test(t)) return stripPunct(t).length >= 5

  // 没有问号：长句、带句读的一律按叙述处理。
  // "周慕之每回上楼前都在柜台前问雾几时散" 就是靠这条挡掉的。
  if (t.length > SHORT_ENOUGH || /[。；]/.test(t)) return false
  if (STRONG.test(t)) return true
  return WH.test(t)
}

function stripPunct(t: string): string {
  return t.replace(/[？?\s。，、；：""''「」『』（）()]/g, '')
}

export interface ClueInput {
  known?: string
  unknown?: string
  /** 旧字段：只有一句话时，能判断成问句就当 unknown，否则当 known */
  text?: string
}

export type ClueIssue = 'clue-no-question' | 'clue-no-known'

/**
 * 把一条线索的输入整理成两段；不合规返回原因。
 *
 * 宁可拒收，也不要把陈述句塞进 unknown：一旦入库，它永远不会自己变成问句，
 * 而档案页会一直显示一条"看起来像摘要"的伏笔。
 */
export function normalizeClue(input: ClueInput): CluePair | ClueIssue {
  const text = (input.text ?? '').trim()
  const knownRaw = (input.known ?? '').trim() || (text && !looksLikeQuestion(text) ? text : '')
  const unknownRaw = (input.unknown ?? '').trim() || (looksLikeQuestion(text) ? text : '')

  if (!looksLikeQuestion(unknownRaw)) return 'clue-no-question'
  if (knownRaw.length < 2) return 'clue-no-known'

  return { known: knownRaw.slice(0, MAX_LEN), unknown: unknownRaw.slice(0, MAX_LEN) }
}
