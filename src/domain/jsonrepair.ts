/**
 * 宽容 JSON 解析。
 * 用户自带任意 OpenAI 兼容实现，不能指望 response_format 一定生效，
 * 所以「剥掉包装 → 取第一个平衡对象 → 逐步轻度修复」这条路必须稳。
 */

export class JsonRepairError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonRepairError'
  }
}

function stripFence(text: string): string {
  return text.replace(/```(?:json|JSON)?\s*/g, '').replace(/```/g, '')
}

/**
 * 从任意文本里取第一个括号平衡的 JSON 对象。
 * 必须正确处理字符串内的 `{`、`}` 与转义引号，否则会在中文对话里提前截断。
 */
export function extractJsonObject(text: string): string | null {
  const s = stripFence(text)
  const start = s.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  // 未闭合：返回剩余部分，交给修复步骤
  return s.slice(start)
}

function removeTrailingCommas(s: string): string {
  return s.replace(/,\s*([}\]])/g, '$1')
}

function normalizeQuotes(s: string): string {
  return s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'")
}

function normalizePunctuation(s: string): string {
  return s.replace(/：/g, ':').replace(/，/g, ',').replace(/\u00a0/g, ' ')
}

/** 把字符串里未转义的真实换行替换成 \\n，其余位置不动。 */
function escapeRawNewlines(s: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escaped) {
        escaped = false
        out += ch
        continue
      }
      if (ch === '\\') {
        escaped = true
        out += ch
        continue
      }
      if (ch === '"') {
        inString = false
        out += ch
        continue
      }
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') continue
      if (ch === '\t') {
        out += '\\t'
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') inString = true
    out += ch
  }
  return out
}

function closeBrackets(s: string): string {
  let inString = false
  let escaped = false
  const stack: string[] = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }
  if (inString) s += '"'
  let tail = ''
  for (let i = stack.length - 1; i >= 0; i--) tail += stack[i] === '{' ? '}' : ']'
  return s + tail
}

/** 依次叠加修复手段，每一步都尝试解析，命中即返回。 */
export function parseLooseJson(text: string): unknown {
  const extracted = extractJsonObject(text)
  if (!extracted) throw new JsonRepairError('没有找到 JSON 对象')

  const steps: Array<(s: string) => string> = [
    (s) => s,
    removeTrailingCommas,
    normalizeQuotes,
    normalizePunctuation,
    escapeRawNewlines,
    closeBrackets,
    (s) => closeBrackets(escapeRawNewlines(normalizePunctuation(normalizeQuotes(removeTrailingCommas(s))))),
  ]

  let lastErr: unknown = null
  for (const step of steps) {
    try {
      return JSON.parse(step(extracted))
    } catch (e) {
      lastErr = e
    }
  }
  throw new JsonRepairError(
    `无法解析 JSON：${lastErr instanceof Error ? lastErr.message : '未知错误'}`,
  )
}
