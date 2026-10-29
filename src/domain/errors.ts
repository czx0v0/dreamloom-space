/** 领域错误与错误码常量（与服务端 §7 对齐）。 */

export const ERR = {
  BAD_REQUEST: 'E_BAD_REQUEST',
  UNAUTHORIZED: 'E_UNAUTHORIZED',
  CONTEXT_TOO_LONG: 'E_CONTEXT_TOO_LONG',
  PARSE_FAILED: 'E_PARSE_FAILED',
  RATE_LIMITED: 'E_RATE_LIMITED',
  QUOTA_EXHAUSTED: 'E_QUOTA_EXHAUSTED',
  FEATURE_OFF: 'E_FEATURE_OFF',
  UPSTREAM_AUTH: 'E_UPSTREAM_AUTH',
  UPSTREAM_5XX: 'E_UPSTREAM_5XX',
  UPSTREAM_TIMEOUT: 'E_UPSTREAM_TIMEOUT',
  NETWORK: 'E_NETWORK',
  NO_KEY: 'E_NO_KEY',
  EMPTY_NARRATION: 'E_EMPTY_NARRATION',
} as const

export type ErrCode = (typeof ERR)[keyof typeof ERR]

/** 面向用户的中文文案：所有错误都必须有可读解释，不允许静默失败。 */
export const ERR_TEXT: Record<string, string> = {
  [ERR.BAD_REQUEST]: '请求参数不对，这次没有发出去。',
  [ERR.UNAUTHORIZED]: '访问口令不正确，请到设置里检查。',
  [ERR.CONTEXT_TOO_LONG]: '上下文超出模型上限，已自动压缩后重试。',
  [ERR.PARSE_FAILED]: '这一段的档案没能整理出来，正文已保留，可以稍后重试。',
  [ERR.RATE_LIMITED]: '请求太密了，等几秒再继续。',
  [ERR.QUOTA_EXHAUSTED]: '今天的共享额度用完了。明天恢复，或在设置里填自己的 Key（不受此限）。',
  [ERR.FEATURE_OFF]: '这个功能还没开放。',
  [ERR.UPSTREAM_AUTH]: 'API Key 配置有误，请检查设置里的 Key 与接口地址。',
  [ERR.UPSTREAM_5XX]: '模型服务暂时不可用，稍后重试。',
  [ERR.UPSTREAM_TIMEOUT]: '模型响应超时了，可以重试一次。',
  [ERR.NETWORK]: '网络连接失败，检查一下网络。',
  [ERR.EMPTY_NARRATION]: '这次没有写出来（模型返回了空内容）。再点一次通常就好了。',
  [ERR.NO_KEY]: '还没有配置 API Key，请到设置页填入。',
}

export class DomainError extends Error {
  code: string
  detail?: unknown

  constructor(code: string, message?: string, detail?: unknown) {
    super(message ?? ERR_TEXT[code] ?? code)
    this.name = 'DomainError'
    this.code = code
    this.detail = detail
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError
}

export function toUserMessage(e: unknown): string {
  if (isDomainError(e)) return e.message
  if (e instanceof Error) return e.message
  return '出了点问题，请重试。'
}
