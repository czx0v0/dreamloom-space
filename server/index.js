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
import { checkMediaAuth, createMedia, MediaError, resolveMediaTarget } from './media.js'
import { MOCK_SEED, mockArchiveResponse, mockNarrateStream } from './mock.js'
import {
  buildArchiveMessages,
  buildChoiceRepairMessages,
  buildDreamMessages,
  buildNarratorMessages,
  buildRepairMessages,
  buildRewriteMessages,
  buildSeedMessages,
  buildSuggestMessages,
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
const media = createMedia(config)

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

/**
 * 前端自带接口地址 / 模型名（BYOK 进阶）。
 *
 * 只允许 https + 域名白名单：开放任意 baseUrl 等于让浏览器借服务端探内网。
 * 用户自己的 key 仍然只走浏览器，服务端不落盘。
 */
const LLM_HOSTS = (process.env.LLM_ALLOWED_HOSTS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean)
const DEFAULT_LLM_HOSTS = [
  'api.deepseek.com',
  'dashscope.aliyuncs.com',
  'dashscope-intl.aliyuncs.com',
  'api.openai.com',
]

/**
 * 允许的接口地址。
 *
 * 只放行 https + 厂商自有域名：允许任意 baseUrl，浏览器就能借服务端探测内网，
 * 服务端变成 SSRF 跳板。百炼的业务空间域名是 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`，
 * 子域名不固定，所以按「后缀」放行 —— 但只限阿里云自有后缀，不是任意域名。
 */
const ALLOWED_SUFFIX = ['.aliyuncs.com', '.maas.aliyuncs.com']

function assertAllowedBase(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new HttpError(400, 'E_BAD_REQUEST', '接口地址不是合法 URL')
  }
  const allowed = new Set([...DEFAULT_LLM_HOSTS, ...LLM_HOSTS])
  const ok =
    url.protocol === 'https:' &&
    (allowed.has(url.hostname) || ALLOWED_SUFFIX.some((suf) => url.hostname.endsWith(suf)))
  if (!ok) {
    throw new HttpError(
      400,
      'E_BAD_REQUEST',
      `不允许这个接口域名。可用：${[...allowed].join('、')} 及 *${ALLOWED_SUFFIX.join(' / *')}`,
    )
  }
  return raw
}

function llmOverride(req) {
  const rawBase = typeof req.headers['x-llm-base'] === 'string' ? req.headers['x-llm-base'].trim() : ''
  const model = typeof req.headers['x-llm-model'] === 'string' ? req.headers['x-llm-model'].trim() : ''
  if (!rawBase) return {}
  assertAllowedBase(rawBase)
  return { baseUrl: rawBase, model: model.slice(0, 60) }
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
  // 必须在写 SSE 头之前校验：头一发出，400 就只能变成流里的一句错误了
  const override = llmOverride(req)
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
          ...override,
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
        ...llmOverride(req),
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

// ── 多模态自检（不生成、不计费） ────────────────────

/**
 * 回答一个具体问题：图和语音的 Key 到底通不通。
 *
 * 请求体为空时只检查站点配置；也可以带上 `{ imageBase, imageKey, ttsBase, ttsKey }` 先测草稿，
 * 省得「先保存再试错」。返回里**绝不出现完整 Key**，只给来源名与后四位。
 */
async function handleMediaCheck(req, res, body) {
  preflight('structured', req, 'media-check')
  const head = (name) => (typeof req.headers[name] === 'string' ? req.headers[name].trim() : '')
  const draft = body ?? {}

  const baseFor = (kind) => {
    const raw = String(draft[`${kind}Base`] ?? '').trim()
    if (raw) assertAllowedBase(raw)
    return raw || config.media[kind === 'image' ? 'image' : 'tts'].baseUrl || config.llm.baseUrl
  }
  const keyFor = (kind) => {
    const own = String(draft[`${kind}Key`] ?? '').trim() || head('x-media-key')
    if (own) return { key: own, source: '浏览器/草稿' }
    const site = config.media[kind === 'image' ? 'image' : 'tts'].key
    if (site) return { key: site, source: kind === 'image' ? 'IMAGE_API_KEY' : 'TTS_API_KEY' }
    return { key: config.llm.apiKey, source: 'LLM_API_KEY' }
  }

  const run = async (kind) => {
    const { key, source } = keyFor(kind)
    const base = baseFor(kind)
    const r = await checkMediaAuth({ kind, baseUrl: base, apiKey: key })
    return {
      ...r,
      keySource: source,
      keyTail: key ? `…${key.slice(-4)}` : '',
      configured: Boolean(config.media[kind === 'image' ? 'image' : 'tts'].baseUrl),
    }
  }

  const [image, tts] = await Promise.all([run('image'), run('tts')])
  log({ route: 'media-check', status: 200, image: image.ok, tts: tts.ok })
  sendJson(res, 200, { image, tts })
}

// ── 生图与语音 ──────────────────────────────────────

/** 1×1 灰点：演示模式下的占位，让 UI 流程可以走通而不烧钱 */
const MOCK_PIXEL =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#e6ddcc"/><text x="256" y="264" font-size="22" text-anchor="middle" fill="#8c8377">演示模式</text></svg>',
  )

/**
 * 生图/语音的接口地址怎么定。
 *
 * 规则：**自带 Key 的人用自己的接口，不许混用站点的 Key 与站点的图床**。
 * 否则 BYOK 用户会拿站点额度去画图，而且请求打到站点配置的供应商上，说不清谁的账。
 */
const hostOf = (url) => {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function mediaTarget(req, kind) {
  const head = (name) => (typeof req.headers[name] === 'string' ? req.headers[name].trim() : '')
  const mediaBase = head('x-media-base')
  const llmBase = head('x-llm-base')
  if (mediaBase) assertAllowedBase(mediaBase)
  if (llmBase) assertAllowedBase(llmBase)

  const siteBase = config.media[kind].baseUrl
  // 站点给图/语音配了独立 Key 就用它；否则只有「同一个厂商」才敢沿用文本 Key。
  // 反例很具体：文本是 DeepSeek、图是百炼，沿用文本 Key 只会换回一个 401，
  // 而 401 的提示是「Key 不对」——用户会去查一把其实没用上的 Key。
  const sameVendor = !siteBase || !config.llm.baseUrl || hostOf(siteBase) === hostOf(config.llm.baseUrl)
  const siteKey = config.media[kind].key || (sameVendor ? config.llm.apiKey : '')
  if (siteBase && !siteKey) {
    throw new MediaError(
      'E_NO_KEY',
      `配了 ${kind === 'image' ? '图' : '语音'}接口地址，但没有配对应的 Key（${kind === 'image' ? 'IMAGE_API_KEY' : 'TTS_API_KEY'}）`,
    )
  }

  return resolveMediaTarget({
    clientBase: mediaBase,
    clientKey: head('x-media-key'),
    clientLlmBase: llmBase,
    clientLlmKey: head('x-llm-key'),
    siteBase,
    siteKey,
    llmBase: config.llm.baseUrl,
  })
}

async function handleImage(req, res, body) {
  preflight('structured', req, 'image')
  const prompt = String(body?.prompt ?? '').trim()
  if (!prompt) throw new HttpError(400, 'E_BAD_REQUEST', '缺少画面描述')

  if (MOCK) {
    sendJson(res, 200, { image: MOCK_PIXEL, model: 'mock', ms: 0 })
    return
  }

  const size = /^\d{2,4}\s*[x*×]\s*\d{2,4}$/.test(String(body?.size ?? '')) ? body.size : '1024x1024'
  const startedAt = Date.now()
  let result
  try {
    result = await media.image({
      prompt,
      size,
      model: typeof body?.model === 'string' ? body.model.slice(0, 60) : '',
      ...mediaTarget(req, 'image'),
    })
  } catch (e) {
    // 已经归一过的错误原样抛；其余一律当成"出图失败"，别让它变成 500
    if (e instanceof MediaError || e instanceof HttpError) throw e
    console.error('[image]', e?.stack || e)
    throw new HttpError(502, 'E_MEDIA_FAILED', '出图失败，可以重试一次')
  }
  log({ route: 'image', ms: Date.now() - startedAt, status: 200, model: result.model })
  sendJson(res, 200, { image: result.image, model: result.model, ms: Date.now() - startedAt })
}

async function handleTts(req, res, body) {
  preflight('structured', req, 'tts')
  const text = String(body?.text ?? '').trim()
  if (!text) throw new HttpError(400, 'E_BAD_REQUEST', '没有要读的内容')
  if (text.length > 900) throw new HttpError(400, 'E_BAD_REQUEST', '一段太长，先按幕读')

  if (MOCK) {
    sendJson(res, 200, { audio: '', model: 'mock', ms: 0 })
    return
  }

  const startedAt = Date.now()
  let result
  try {
    result = await media.speech({
      text,
      voice: typeof body?.voice === 'string' ? body.voice.slice(0, 40) : '',
      speed: body?.speed,
      model: typeof body?.model === 'string' ? body.model.slice(0, 60) : '',
      ...mediaTarget(req, 'tts'),
    })
  } catch (e) {
    if (e instanceof MediaError || e instanceof HttpError) throw e
    console.error('[tts]', e?.stack || e)
    throw new HttpError(502, 'E_MEDIA_FAILED', '语音合成失败，可以重试一次')
  }
  log({ route: 'tts', ms: Date.now() - startedAt, status: 200, model: result.model })
  sendJson(res, 200, { audio: result.audio, model: result.model, ms: Date.now() - startedAt })
}

// ── 连通性探测（设置页「测试连接」） ──────────────────

async function handlePing(req, res) {
  preflight('structured', req, 'ping')
  const key = typeof req.headers['x-llm-key'] === 'string' ? req.headers['x-llm-key'] : ''
  // 白名单校验放在最前面：非法地址要报「地址不允许」，不能报成网络错误
  const override = llmOverride(req)

  if (MOCK) {
    sendJson(res, 200, { ok: true, ms: 12, model: override.model || 'mock', endpoint: 'mock' })
    return
  }
  if (!key && !config.llm.apiKey) {
    throw new HttpError(400, 'E_NO_KEY', '还没有配置 API Key')
  }

  const result = await llm.probe({ apiKey: key, ...override })
  log({ route: 'ping', ms: result.ms, status: 200 })
  sendJson(res, 200, result)
}

// ── 辅助生成（固定事件 / 隐藏秘密） ────────────────────

async function handleSuggest(req, res, body) {
  preflight('structured', req, 'suggest')
  const key = typeof req.headers['x-llm-key'] === 'string' ? req.headers['x-llm-key'] : ''
  if (!MOCK && !key && !config.llm.apiKey) {
    throw new HttpError(400, 'E_NO_KEY', '还没有配置 API Key')
  }

  const kind = body?.kind === 'hidden' ? 'hidden' : 'events'
  const context = body?.context ?? {}

  if (MOCK) {
    sendJson(res, 200, {
      text:
        kind === 'hidden'
          ? '{"items":["他当年替人顶了一桩案子","那封信其实是他写的"]}'
          : '{"items":["码头封了，所有船都不许出港","有人把客栈的旧账本烧了","阿棠失踪了一夜"]}',
    })
    return
  }

  const startedAt = Date.now()
  const result = await llm.complete(
    buildSuggestMessages({ kind, context, target: body?.target }),
    {
      temperature: 0.95,
      maxTokens: 400,
      totalTimeoutMs: config.llm.timeouts.totalStructuredMs,
      apiKey: key,
        ...llmOverride(req),
      responseFormat: { type: 'json_object' },
    },
  )
  chargeUsage(req, (result.text ?? '').length + (result.usage?.prompt_tokens ?? 0))
  log({ route: 'suggest', chars: (result.text ?? '').length, ms: Date.now() - startedAt, status: 200 })
  sendJson(res, 200, { text: result.text })
}

// ── 入梦（最小版：一次一步） ────────────────────────────

async function handleDream(req, res, body) {
  preflight('structured', req, 'dream')
  const key = typeof req.headers['x-llm-key'] === 'string' ? req.headers['x-llm-key'] : ''
  if (!MOCK && !key && !config.llm.apiKey) {
    throw new HttpError(400, 'E_NO_KEY', '还没有配置 API Key')
  }

  const command = String(body?.command ?? '').trim()
  if (!command) throw new HttpError(400, 'E_BAD_REQUEST', '先说要做什么')
  if (command.length > 120) throw new HttpError(400, 'E_BAD_REQUEST', '这一步说得太长了')

  if (MOCK) {
    sendJson(res, 200, { narration: '雾把灯影揉成一团。你听见自己的脚步在石板上拖了一下。' })
    return
  }

  const startedAt = Date.now()
  const result = await llm.complete(
    buildDreamMessages({
      placeName: String(body?.placeName ?? '').slice(0, 30),
      present: Array.isArray(body?.present) ? body.present.slice(0, 8) : [],
      command,
      recent: Array.isArray(body?.recent) ? body.recent.slice(-3) : [],
    }),
    {
      temperature: 0.85,
      maxTokens: 400,
      totalTimeoutMs: config.llm.timeouts.totalStructuredMs,
      apiKey: key,
        ...llmOverride(req),
    },
  )
  chargeUsage(req, (result.text ?? '').length + (result.usage?.prompt_tokens ?? 0))
  log({ route: 'dream', chars: (result.text ?? '').length, ms: Date.now() - startedAt, status: 200 })
  sendJson(res, 200, { narration: String(result.text ?? '').trim() })
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
        ...llmOverride(req),
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
        ...llmOverride(req),
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
    buildSeedMessages({
      oneLine,
      genre: body?.genre,
      tone: body?.tone,
      hints: body?.hints,
    }),
    {
      temperature: 0.95,
      maxTokens: 1400,
      totalTimeoutMs: config.llm.timeouts.totalStructuredMs,
      apiKey: key,
        ...llmOverride(req),
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
        ...llmOverride(req),
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
  if (error instanceof MediaError) {
    return { status: statusFor(error.code), code: error.code, message: error.message }
  }
  return { status: 500, code: 'E_INTERNAL', message: '服务器内部错误' }
}

// ── 静态资源 ────────────────────────────────────────────

function serveStatic(req, res, pathname) {
  // 有些部署平台会剔除 `dist/`（把它当构建产物），所以允许 `web/` 作为同内容的备选目录
  const dist = [join(ROOT, 'dist'), join(ROOT, 'web')].find((p) => existsSync(p)) ?? join(ROOT, 'dist')
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

    if (pathname === '/api/ping' && req.method === 'POST') {
      await handlePing(req, res)
      return
    }

    if (pathname === '/api/suggest' && req.method === 'POST') {
      await handleSuggest(req, res, await readJson(req))
      return
    }

    if (pathname === '/api/dream' && req.method === 'POST') {
      await handleDream(req, res, await readJson(req))
      return
    }

    if (pathname === '/api/media-check' && req.method === 'POST') {
      await handleMediaCheck(req, res, await readJson(req))
      return
    }

    if (pathname === '/api/image' && req.method === 'POST') {
      await handleImage(req, res, await readJson(req))
      return
    }

    if (pathname === '/api/tts' && req.method === 'POST') {
      await handleTts(req, res, await readJson(req))
      return
    }

    if (pathname === '/api/outline' && req.method === 'POST') {
      checkToken(req)
      throw new HttpError(501, 'E_FEATURE_OFF', '这个功能还没开放')
    }

    if (pathname.startsWith('/api/')) {
      throw new HttpError(404, 'E_NOT_FOUND', '没有这个接口')
    }

    serveStatic(req, res, pathname)
  } catch (error) {
    const normalized = normalizeForClient(error)
    // 500 说明是我们没预料的异常：一定要把栈打出来，否则线上只剩"Internal Server Error"
    if (normalized.status >= 500) {
      console.error('[unhandled]', pathname, error?.stack || error)
    }
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

// 显式绑 0.0.0.0：容器/沙箱里的健康检查是从外部打进来的，
// 只绑 localhost 时本地能开、平台却报"端口没响应"。
const HOST = process.env.HOST || '0.0.0.0'
server.listen(port, HOST, () => {
  const mode = MOCK ? '演示模式（LLM_MOCK=1）' : `模型 ${config.llm.model || '(未配置)'}`
  console.log(`筑梦之境 · 服务已启动  http://${HOST}:${port}  ${mode}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
