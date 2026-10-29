/**
 * 名称归一化与相似判定。
 * 目标：同一人物在正文里被写成「林昭」「林昭昭」「"林昭"」「林昭先生」时能落到同一 id，
 * 同时绝不能把「李雷」和「李雪」合并。
 */

const TITLES = /(先生|女士|小姐|老师|同学|大人|阁下|前辈|师傅|老板|医生|教授)$/

/** 全角 → 半角（含全角空格） */
function toHalfWidth(s: string): string {
  return s
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
}

export function normalizeName(raw: string): string {
  if (!raw) return ''
  let s = toHalfWidth(raw.trim()).toLowerCase()
  // 去掉引号、书名号、括号与常见标点
  s = s.replace(/[《》「」『』【】\[\]()（）"'“”‘’`·・.,，。!！?？:：;；、~～—\-_/\\]/g, '')
  // 只有剥掉称谓后仍剩 ≥2 字才剥：「林昭先生」→「林昭」可以，
  // 但「林老板」→「林」会把一个绰号和真叫「林」的人撞在一起，所以不剥。
  const stripped = s.replace(TITLES, '')
  if (stripped.length >= 2) s = stripped
  s = s.replace(/\s+/g, '')
  return s
}

/** 编辑距离，带早停：超过 max 直接返回 max+1。 */
export function levenshtein(a: string, b: string, max = 3): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  if (Math.abs(a.length - b.length) > max) return max + 1

  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = curr[0]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (rowMin > max) return max + 1
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[b.length]
}

/**
 * 严格判等：归一化后完全相同才算同一实体（用于自动合并）。
 * 刻意不做任何模糊匹配 —— 中文两字名共用姓氏太常见，
 * 「李雷/李雪」距离只有 1，「王刚/王钢」也是，合并它们是不可接受的错误。
 */
export function isSameName(a: string, b: string): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  return Boolean(na) && na === nb
}

/**
 * 相似判定：只用于给用户提示「这两个可能是同一个人，可手动合并」，
 * 绝不用于自动合并。仅对 3 字以上的名字启用，且要求首字相同、距离 ≤1。
 */
export function isSimilarName(a: string, b: string): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb || na === nb) return false
  if (na.length < 3 || nb.length < 3) return false
  if (na[0] !== nb[0]) return false
  return levenshtein(na, nb, 1) <= 1
}

/** 用于去重的稳定哈希（非加密）。 */
export function hashText(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
