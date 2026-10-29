/** 极小的请求/响应工具：只做本项目需要的那几件事。 */

const MAX_BODY = 1024 * 1024

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

export function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, { error: { code, message, ...extra } })
}

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

export async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) {
      throw new HttpError(413, 'E_PAYLOAD_TOO_LARGE', '请求体过大')
    }
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'E_BAD_REQUEST', '请求体不是合法 JSON')
  }
}

export const STATUS_BY_CODE = {
  E_BAD_REQUEST: 400,
  E_UNAUTHORIZED: 401,
  E_PAYLOAD_TOO_LARGE: 413,
  E_CONTEXT_TOO_LONG: 413,
  E_PARSE_FAILED: 422,
  E_RATE_LIMITED: 429,
  E_QUOTA_EXHAUSTED: 429,
  E_FEATURE_OFF: 501,
  E_NO_KEY: 400,
  E_UPSTREAM_AUTH: 502,
  E_UPSTREAM_5XX: 502,
  E_UPSTREAM_TIMEOUT: 504,
  E_NETWORK: 502,
  E_MEDIA_FAILED: 502,
  E_MEDIA_UNSUPPORTED: 400,
}

export function statusFor(code) {
  return STATUS_BY_CODE[code] ?? 500
}
