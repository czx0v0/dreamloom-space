/**
 * 上游 LLM 调用（OpenAI 兼容）。
 *
 * 三条约束写死在这里，别处不要重写：
 *  1. 首字节之前才允许重试（已开始输出后重试会把正文拼错）
 *  2. 三段超时：首字节 / 空闲 / 总时长
 *  3. 错误统一归一成错误码，前端只认错误码
 */

import { parseSseStream } from './sse.js'

export class LlmError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code)
    this.name = 'LlmError'
    this.code = code
    Object.assign(this, extra)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createLlm(cfg, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch

  function resolveKey(override) {
    const key = (override || '').trim() || cfg.llm.apiKey
    if (!key) throw new LlmError('E_NO_KEY', '还没有配置 API Key')
    return key
  }

  async function request(messages, opts) {
    if (!cfg.llm.baseUrl || !cfg.llm.model) {
      throw new LlmError('E_NO_KEY', '还没有配置接口地址或模型名')
    }
    const controller = new AbortController()
    const timers = []
    const clearTimers = () => timers.forEach((t) => clearTimeout(t))

    const onAbort = () => controller.abort()
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true })

    timers.push(
      setTimeout(() => controller.abort(new LlmError('E_UPSTREAM_TIMEOUT', '等待首字节超时')), cfg.llm.timeouts.firstByteMs),
    )
    if (opts.totalTimeoutMs) {
      timers.push(
        setTimeout(
          () => controller.abort(new LlmError('E_UPSTREAM_TIMEOUT', '请求总时长超时')),
          opts.totalTimeoutMs,
        ),
      )
    }

    const body = {
      model: cfg.llm.model,
      messages,
      stream: true,
      temperature: opts.temperature ?? cfg.llm.temperature.narrator,
    }
    if (opts.maxTokens) body.max_tokens = opts.maxTokens
    if (opts.responseFormat) body.response_format = opts.responseFormat
    if (opts.streamOptions) body.stream_options = opts.streamOptions

    let res
    try {
      res = await fetchImpl(`${cfg.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolveKey(opts.apiKey)}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimers()
      throw normalizeError(error)
    }

    if (!res.ok) {
      clearTimers()
      const detail = await safeText(res)
      throw httpError(res.status, detail, res.headers.get('retry-after'))
    }

    return { res, controller, clearTimers, resetIdle: () => resetIdle(timers, controller) }
  }

  function resetIdle(timers, controller) {
    // 用总时长兜底即可；这里只负责把「首字节」计时器换掉
    timers.forEach((t) => clearTimeout(t))
  }

  async function* stream(messages, opts = {}) {
    const maxAttempts = (cfg.llm.retry.maxAttempts ?? 1) + 1
    let lastError = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let started = false
      try {
        const { res, controller, clearTimers } = await request(messages, opts)
        const idleTimer = setTimeout(
          () => controller.abort(new LlmError('E_UPSTREAM_TIMEOUT', '空闲超时')),
          cfg.llm.timeouts.idleMs,
        )
        try {
          for await (const frame of parseSseStream(res.body)) {
            if (frame.data === '[DONE]') break
            let parsed
            try {
              parsed = JSON.parse(frame.data)
            } catch {
              continue
            }
            if (parsed.error) {
              throw new LlmError('E_UPSTREAM_5XX', parsed.error.message || '上游返回错误', {
                detail: parsed.error.code,
              })
            }
            const choice = parsed.choices?.[0]
            const delta = choice?.delta ?? {}
            if (delta.content) {
              started = true
              yield { content: delta.content }
            }
            if (parsed.usage) yield { usage: parsed.usage }
            if (choice?.finish_reason) yield { finishReason: choice.finish_reason }
          }
        } finally {
          clearTimeout(idleTimer)
          clearTimers()
        }
        return
      } catch (error) {
        lastError = normalizeError(error)
        if (started || attempt >= maxAttempts || !isRetryable(lastError)) throw lastError

        // 指数退避：上游抖动时立刻重试往往还是失败，拉开间隔更容易成功
        const base = cfg.llm.retry.backoffMs ?? 500
        const wait = Math.min(4000, base * 2 ** (attempt - 1))
        // 让上层能把「正在重试」告诉用户：静默重试会让人以为卡死了
        yield { retry: { attempt, maxAttempts, code: lastError.code, waitMs: wait } }
        await sleep(wait)
      }
    }
    throw lastError ?? new LlmError('E_UPSTREAM_5XX', '上游调用失败')
  }

  async function complete(messages, opts = {}) {
    let text = ''
    let usage = null
    let finishReason = null
    for await (const chunk of stream(messages, opts)) {
      if (chunk.content) text += chunk.content
      if (chunk.usage) usage = chunk.usage
      if (chunk.finishReason) finishReason = chunk.finishReason
    }
    return { text, usage, finishReason }
  }

  return { stream, complete }
}

function isRetryable(error) {
  return ['E_UPSTREAM_TIMEOUT', 'E_UPSTREAM_5XX', 'E_NETWORK', 'E_RATE_LIMITED'].includes(error.code)
}

function httpError(status, detail, retryAfter) {
  if (status === 401 || status === 403) {
    return new LlmError('E_UPSTREAM_AUTH', 'API Key 或接口地址不正确', { status })
  }
  if (status === 429) {
    const seconds = Number(retryAfter)
    return new LlmError('E_RATE_LIMITED', '上游限流', {
      status,
      retryAfterMs: Number.isFinite(seconds) ? seconds * 1000 : 3000,
    })
  }
  if (status === 413) return new LlmError('E_CONTEXT_TOO_LONG', '上下文超出模型上限', { status })
  if (status >= 500) return new LlmError('E_UPSTREAM_5XX', '模型服务暂时不可用', { status, detail })
  return new LlmError('E_BAD_REQUEST', `上游拒绝请求（${status}）`, { status, detail })
}

function normalizeError(error) {
  if (error instanceof LlmError) return error
  if (error?.name === 'AbortError') {
    return new LlmError('E_UPSTREAM_TIMEOUT', '请求被中止或超时')
  }
  return new LlmError('E_NETWORK', error?.message || '网络错误')
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return ''
  }
}
