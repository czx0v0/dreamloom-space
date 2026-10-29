/**
 * 文本工具：用户输入清洗 + 相似度。
 *
 * 放在 domain 而不是 UI：两者都要被单测覆盖，而且"截断到多少字"
 * 是产品规则不是样式细节。
 */

/** 控制字符、零宽字符、BOM。零宽字符最常见于从网页复制来的文本。 */
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g

/**
 * 清洗用户输入。
 *
 * 三件事，缺一不可：
 *  1. 去掉不可见字符——它们会破坏 JSON 与 prompt 结构；
 *  2. 统一换行；
 *  3. 截断——前端 maxLength 不可信，服务端必须再截一次。
 */
export function sanitizeUserText(raw: string, maxChars = 200): string {
  if (!raw) return ''
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, Math.max(1, maxChars))
}

/** 归一化：只保留中文、字母与数字，用于相似度比较。 */
function compact(text: string): string {
  return (text ?? '').toLowerCase().replace(/[^\p{Script=Han}a-z0-9]/gu, '')
}

function grams(text: string, size: number): Set<string> {
  const s = compact(text)
  const out = new Set<string>()
  if (!s) return out
  if (s.length <= size) {
    out.add(s)
    return out
  }
  for (let i = 0; i <= s.length - size; i++) out.add(s.slice(i, i + size))
  return out
}

/**
 * 覆盖度：交集 ÷ 较小集合的大小。
 *
 * 不用 Jaccard 的原因很具体——它区分不开这两组：
 *   「提货单被海关扣下…查旧账」/「海关扣了三号仓库的提货单」 Jaccard 0.47（其实是同一件事）
 *   「林昭在码头等他」/「林昭在仓库等他」                  Jaccard 0.56（其实是两件事）
 * 覆盖度下分别是 0.92 与 0.71，这才分得开：同一件事的两种详略会被包含，
 * 而结构相同、关键名词不同则不会。判成同一件事比漏判更糟，所以宁可分开。
 */
function coverage(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const g of small) if (large.has(g)) shared++
  return shared / small.size
}

/**
 * 两段文本的相似度（0–1）。
 *
 * 取「单字集合」与「双字集合」Jaccard 的较大者，原因很具体：
 *  - 只用 2-gram，对**换语序**几乎不敏感。「周慕之那夜去哪了」与
 *    「那夜周慕之去了哪儿」是同一件事，2-gram 只有 0.15；
 *  - 只用 1-gram，又抓不到「连续短语相同」这类更强的证据。
 *
 * 中文复述同一件事最常见的方式恰恰是换语序，所以 1-gram 是主力。
 */
export function textSimilarity(a: string, b: string): number {
  const sa = compact(a)
  const sb = compact(b)
  if (!sa || !sb) return 0
  if (sa === sb) return 1
  // 一段完整包含另一段：几乎可以确定是同一件事的不同详略
  if (sa.length >= 8 && sb.length >= 8 && (sa.includes(sb) || sb.includes(sa))) return 0.9

  return Math.max(coverage(grams(a, 1), grams(b, 1)), coverage(grams(a, 2), grams(b, 2)))
}
