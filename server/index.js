/**
 * 服务端入口：单端口同时托管 SPA 与 /api。
 *
 * 约束（为了在任何容器平台都能跑）：
 *  - 端口读 process.env.PORT（ModelScope Docker 创空间固定 7860）
 *  - 不写磁盘：存档在浏览器，服务器完全无状态
 *  - 密钥只从环境变量或请求头取，永不落盘、永不进日志
 */

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { config, getPublicConfig, MOCK, ROOT } from './config.js'
import { createGuard, clientIp } from './guard.js'
import { createLlm, LlmError } from './llm.js'
import { MOCK_SEED, mockArchiveResponse, mockNarrateStream } from './mock.js'
import {
  buildArchiveMessages,
  buildChoiceRepairMessages,
  buildNarratorMessages,
  buildRepairMessages,
  buildRewriteMessages,
  buildSeedMessages,
  buildTriageMessages,
  promptOverhead,
} from './prompts.js'
import { HttpError, readJson, sendError, sendJson, statusFor } from './router.js'
import { createSse } from './sse.js'

const guard = createGuard({
  narrateRpm: config.ratelimit.narrateRpm,
  structuredRpm: config.ratelimit.structuredRpm,
  maxConcurrency: config.ratelimit.maxConcurrency,
  dailyCharBudget: config.dailyCharBudget,
})
const llm = createLlm(config)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function log(entry) {
  // 只记可公开的指标；请求体、prompt、上游 header 一律不记。
  console.log(
    JSON.stringify({
      t: new Date().toISOString(),
      ...entry,
    }),
  )
}

function checkToken(req) {
  if (!config.accessToken) return
  const token = req.headers['x-dreamloom-token']
  if (token !== config.accessToken) {
    throw new HttpError(401, 'E_UNAUTHORIZED', '访问口令不正确')
  }
}

function hasOwnKey(req) {
  const key = req.headers['x-llm-key']
  return typeof key === 'string' && key.trim() !== ''
}

/**
 * 只有用服务端 Key 的请求才计额度。
 *
 * 额度存在的理由是「别人用我的 Key 我不该替他付钱」，
 * 而不是「限制用户花自己的钱」。早前不分通道一律计费，
 * 结果是自带 Key 的人跑到第 37 幕被自己的服务端拦住。
 */
function chargeUsage(req, chars) {
  if (hasOwnKey(req)) return
  guard.charge(chars)
}

function preflight(route, req, limitKey) {
  checkToken(req)
  const rl = guard.take(route, clientIp(req))
  if (!rl.ok) {
    throw new HttpError(429, rl.code, '请求太密了', { retryAfterMs: rl.retryAfterMs })
  }
  if (!hasOwnKey(req) && guard.quotaExceeded()) {
    throw new HttpError(429, 'E_QUOTA_EXHAUSTED', '今天的额度用完了')
  }
  void limitKey
}

function clampBudget(body) {
  const target = body?.target ?? {}
  const min = Math.min(2000, Math.max(80, Number(target.min) || 450))
  const max = Math.min(2500, Math.max(min + 20, Number(target.max) || 700))
  return { min, max }
}

// ── 叙事（流式） ────────────────────────────────────────

async function handleNarrate(req, res, body) {
  preflight('narrate', req, 'narrate')
  const key = typeof req.headers['x-llm-key'] === 'string' ? req.headers['x-llm-key'] : ''
  if (!MOCK && !key && !config.llm.apiKey) {
    throw new HttpError(400, 'E_NO_KEY', '还没有配置 API Key')
  }
  if (!guard.acquire()) {
    throw new HttpError(429, 'E_RATE_LIMITED', '同时进行的请求太多了', { retryAfterMs: 1500 })
  }

  const startedAt = Date.now()
  const runId = `rn_${startedAt.toString(36)}`
  const sse = createSse(res)
  const controller = new AbortController()
  req.on('close', () => controller.abort())

  let text = ''
  let usage = { inTok: 0, outTok: 0 }
  const target = clampBudget(body)

  try {
    sse.send('meta', { runId, model: MOCK ? 'mock' : config.llm.model })

    // 前端限制不可信：action 可能是重写时追加过说明的长字符串，这里再截一次
    const sections = body?.sections && typeof body.sections === 'object' ? { ...body.sections } : {}
    if (typeof sections.action === 'string') {
      sections.action = sections.action.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b-\u200f\ufeff]/g, '').slice(0, 600)
    }

    const request = {
      ...body,
      sections,
      target,
      choiceCount: Math.min(5, Math.max(0, Number(body?.choiceCount) || 0)),
    }
    const messages = buildNarratorMessages(request)

    const source = MOCK
      ? mockNarrateStream(request)
      : llm.stream(messages, {
          temperature: Number(body?.temperature) || config.llm.temperature.narrator,
          maxTokens: Math.ceil((target.max * 2.2) / 1),
          totalTimeoutMs: config.llm.timeouts.totalNarrateMs,
          apiKey: key,
          streamOptions: { include_usage: true },
          signal: controller.signal,
        })

    for await (const chunk of source) {
      if (chunk.retry) {
        sse.send('notice', {
          code: 'E_RETRY',
          attempt: chunk.retry.attempt,
          maxAttempts: chunk.retry.maxAttempts,
          detail: chunk.retry.code,
        })
      }
      if (chunk.content) {
        text += chunk.content
        sse.send('delta', { d: chunk.content })
      }
      if (chunk.usage) {
        usage = {
          inTok: chunk.usage.prompt_tokens ?? 0,
          outTok: chunk.usage.completion_tokens ?? 0,
        }
      }
    }

    let choices = extractChoices(text)
    if (!choices.length && !MOCK && text.trim()) {
      // 模型漏了 <choices>：单独补一次，成本远低于让玩家看到占位选项
      try {
        const fix = await llm.complete(buildChoiceRepairMessages(text, request.choiceCount || 3), {
          temperature: 0.4,
          maxTokens: 220,
          totalTimeoutMs: 20000,
          apiKey: key,
        })
        choices = parseChoiceLines(fix.text, request.choiceCount || 3)
      } catch {
        /* 补不出来就让前端兜底，不阻塞 */
      }
    }
    const chars = text.replace(/\s/g, '').length
    chargeUsage(req, chars + usage.inTok)

    sse.send('usage', usage)
    sse.send('done', {
      finishReason: 'stop',
      chars,
      ms: Date.now() - startedAt,
      choices,
    })
    log({
      route: 'narrate',
      runId,
      chars,
      ms: Date.now() - startedAt,
      status: 200,
      mock: MOCK,
    })
  } catch (error) {
    const normalized = normalizeForClient(error)
    sse.send('notice', { code: normalized.code, detail: normalized.message })
    log({ route: 'narrate', runId, status: normalized.status, code: normalized.code })
  } finally {
    sse.close()
    guard.release()
  }
}

function parseChoiceLines(raw, limit) {
  return String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+\s*[.、)．]|[-*•·])\s*/, '').trim())
    .filter((line) => line.length > 0 && line.length <= 40)
    .slice(0, limit)
}

function extractChoices(raw) {
  const match = /<choices>([\s\S]*?)<\/choices>/.exec(raw)
  if (!match) return []
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+\s*[.、)．]|[-*•·])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 5)
}

// ── 收线判定（非流式，输入输出都很短） ──────────────────

async function handleTriage(req, res, body) {
  preflight('structured', req, 'triage')
  const key = typeof req.headers['x-llm-key'] === 'string' ? req.headers['x-llm-key'] : ''
  if (!MOCK && !key && !config.llm.apiKey) {
    throw new HttpError(400, 'E_NO_KEY', '还没有配置 API Key')
  }

  const sceneText = String(body?.sceneText ?? '').slice(-3000)
  const clues = Array.isArray(body?.clues) ? body.clues.slice(0, 12) : []
  const places = Array.isArray(body?.places) ? body.places.slice(0, 20) : []
  if (!sceneText.trim() || !clues.length) {
    throw new HttpError(400, 'E_BAD_REQUEST', '没有需要判定的问题')
  }

  if (MOCK) {
    sendJson(res, 200, { text: '{"resolved":[],"place":null}' })
    return
  }

  const startedAt = Date.now()
  const result = await llm.complete(buildTriageMessages({ sceneText, clues, places }), {
    temperature: 0,
    maxTokens: 300,
    totalTimeoutMs: config.llm.timeouts.totalStructuredMs,
    apiKey: key,
    responseFormat: { type: 'json_object' },
  })

  chargeUsage(req, (result.text ?? '').length + (result.usage?.prompt_tokens ?? 0))
  log({ route: 'triage', chars: (result.text ?? '').length, ms: Date.now() - startedAt, status: 200 })
  sendJson(res, 200, { text: result.text, usage: result.usage ?? { inTok: 0, outTok: 0 } })
}

// ── 抽取（非流式） ──────────────────────────────────────
/**
 * 一句话 → 完整空间设定。
 *
 * 与 archive 同一个原则：服务端只负责「让模型产出 JSON」，校验与降级在客户端。
 * 这样 validateSeed 只有一份实现，且能被单测覆盖。
 */
/**
 * 改写某一幕（压缩 / 重写）。
 *
 * 不落库：正文是权威数据，只有用户在界面上确认后才写。
 * 这样"顺手点了一下压缩"不会悄悄改掉历史。
 */
async function handleRewrite(req, res, body) {
  preflight('structured', req, 'rewrite')
  const key = typeof req.headers['x-llm-key'] === 'string' ? req.headers['x-llm-key'] : ''
  if (!MOCK && !key && !config.llm.apiKey) {
    throw new HttpError(400, 'E_NO_KEY', '还没有配置 API Key')
  }

  const text = String(body?.text ?? '').trim()
  if (text.length < 30) throw new HttpError(400, 'E_BAD_REQUEST', '正文太短，不需要改写')
  if (text.length > 6000) throw new HttpError(400, 'E_BAD_REQUEST', '这一幕太长了，先分段处理')

  const mode = body?.mode === 'rewrite' ? 'rewrite' : 'compress'
  const targetChars = Number(body?.targetChars) || Math.max(150, Math.round(text.length / 2))
  const startedAt = Date.now()

  const result = await llm.complete(buildRewriteMessages({ mode, text, targetChars }), {
    temperature: mode === 'compress' ? 0.4 : 0.9,
    maxTokens: Math.ceil(text.length * 1.6),
    totalTimeoutMs: config.llm.timeouts.totalStructuredMs,
    apiKey: key,
  })

  chargeUsage(req, (result.text ?? '').length)
  log({ route: 'rewrite', chars: (result.text ?? '').length, ms: Date.now() - startedAt, status: 200 })
  sendJson(res, 200, { text: result.text, usage: result.usage ?? { inTok: 0, outTok: 0 } })
}

async function handleSeed(req, res, body) {
  preflight('structured', req, 'seed')
  const key = typeof req.headers['x-llm-key'] === 'string' ? req.headers['x-llm-key'] : ''
  if (!MOCK && !key && !config.llm.apiKey) {
    throw new HttpError(400, 'E_NO_KEY', '还没有配置 API Key')
  }

  const oneLine = String(body?.oneLine ?? '').trim().slice(0, 200)
  if (!oneLine) throw new HttpError(400, 'E_BAD_REQUEST', '用一句话说说你想写什么')

  const startedAt = Date.now()

  if (MOCK) {
    sendJson(res, 200, { text: MOCK_SEED, usage: { inTok: 0, outTok: 0 } })
    return
  }

  const result = await llm.complete(
    buildSeedMessages({ oneLine, genre: body?.genre, tone: body?.tone }),
    {
      temperature: 0.95,
      maxTokens: 1400,
      totalTimeoutMs: config.llm.timeouts.totalStructuredMs,
      apiKey: key,
      responseFormat: { type: 'json_object' },
    },
  )

  chargeUsage(req, (result.text ?? '').length + (result.usage?.prompt_tokens ?? 0))
  log({ route: 'seed', chars: (result.text ?? '').length, ms: Date.now() - startedAt, status: 200 })
  sendJson(res, 200, { text: result.text, usage: result.usage ?? { inTok: 0, outTok: 0 } })
}

async function handleArchive(req, res, body) {
  preflight('structured', req, 'archive')
  const key = typeof req.headers['x-llm-key'] === 'string' ? req.headers['x-llm-key'] : ''
  if (!MOCK && !key && !config.llm.apiKey) {
    throw new HttpError(400, 'E_NO_KEY', '还没有配置 API Key')
  }

  const repair = body?.repair?.previousRaw
  const sceneText = String(body?.sceneText ?? '').slice(0, 6000)
  if (!repair && !sceneText.trim()) {
    throw new HttpError(400, 'E_BAD_REQUEST', 'sceneText 不能为空')
  }

  const startedAt = Date.now()
  const result = MOCK
    ? await mockArchiveResponse({ sceneText })
    : await llm.complete(repair ? buildRepairMessages(repair) : buildArchiveMessages({ ...body, sceneText }), {
        temperature: config.llm.temperature.archivist,
        maxTokens: 1200,
        totalTimeoutMs: config.llm.timeouts.totalStructuredMs,
        apiKey: key,
        responseFormat: { type: 'json_object' },
      })

  chargeUsage(req, (result.text ?? '').length + (result.usage?.prompt_tokens ?? 0))
  log({
    route: 'archive',
    chars: (result.text ?? '').length,
    ms: Date.now() - startedAt,
    status: 200,
    repaired: Boolean(repair),
  })

  sendJson(res, 200, {
    text: result.text,
    usage: {
      inTok: result.usage?.prompt_tokens ?? 0,
      outTok: result.usage?.completion_tokens ?? 0,
    },
    repaired: Boolean(repair),
  })
}

function normalizeForClient(error) {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message }
  }
  if (error instanceof LlmError) {
    return { status: statusFor(error.code), code: error.code, message: error.message }
  }
  return { status: 500, code: 'E_INTERNAL', message: '服务器内部错误' }
}

// ── 静态资源 ────────────────────────────────────────────

function serveStatic(req, res, pathname) {
  const dist = join(ROOT, 'dist')
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  let filePath = resolve(dist, `.${safePath}`)

  if (!filePath.startsWith(dist)) {
    sendError(res, 403, 'E_FORBIDDEN', '路径不合法')
    return
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(dist, 'index.html')
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('前端还没构建：先运行 npm run build')
    return
  }

  const ext = extname(filePath)
  const isHtml = ext === '.html'
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  createReadStream(filePath).pipe(res)
}

// ── 路由 ────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const pathname = url.pathname

  try {
    if (pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        mock: MOCK,
        model: MOCK ? 'mock' : config.llm.model || null,
        uptime: Math.round(process.uptime()),
        ...guard.status(),
      })
      return
    }

    if (pathname === '/api/config') {
      sendJson(res, 200, { ...getPublicConfig(), promptOverhead: promptOverhead() })
      return
    }

    if (pathname === '/api/narrate' && req.method === 'POST') {
      await handleNarrate(req, res, await readJson(req))
      return
    }

    if (pathname === '/api/archive' && req.method === 'POST') {
      await handleArchive(req, res, await readJson(req))
      return
    }

    if (pathname === '/api/rewrite' && req.method === 'POST') {
      await handleRewrite(req, res, await readJson(req))
      return
    }

    if (pathname === '/api/triage' && req.method === 'POST') {
      await handleTriage(req, res, await readJson(req))
      return
    }

    if (pathname === '/api/seed' && req.method === 'POST') {
      await handleSeed(req, res, await readJson(req))
      return
    }

    if (
      ['/api/outline', '/api/tts', '/api/image', '/api/dream'].includes(pathname) &&
      req.method === 'POST'
    ) {
      checkToken(req)
      throw new HttpError(501, 'E_FEATURE_OFF', '这个功能还没开放')
    }

    if (pathname.startsWith('/api/')) {
      throw new HttpError(404, 'E_NOT_FOUND', '没有这个接口')
    }

    serveStatic(req, res, pathname)
  } catch (error) {
    const normalized = normalizeForClient(error)
    if (res.headersSent) {
      try {
        res.end()
      } catch {
        /* ignore */
      }
      return
    }
    sendError(res, normalized.status, normalized.code, normalized.message)
    log({ route: pathname, status: normalized.status, code: normalized.code })
  }
})

const port = config.port

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      [
        '',
        `端口 ${port} 已被占用。`,
        '  - 可能你之前已经启动过一次服务（另开一个终端在用）',
        '  - Windows 查看占用：netstat -ano | findstr :' + port,
        '  - macOS / Linux：lsof -i :' + port,
        '  - 或者换一个端口：PORT=3001 npm run dev:api',
        '',
      ].join('\n'),
    )
    process.exit(1)
  }
  console.error('服务启动失败：', err?.message ?? err)
  process.exit(1)
})

server.listen(port, () => {
  const mode = MOCK ? '演示模式（LLM_MOCK=1）' : `模型 ${config.llm.model || '(未配置)'}`
  console.log(`筑梦之境 · 服务已启动  http://localhost:${port}  ${mode}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
