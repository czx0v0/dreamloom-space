/**
 * 多模态：生图与语音。
 *
 * 只认两种协议，供应商差异全在这一层吸收：
 *  - `openai`    ：`/images/generations`、`/audio/speech`（OpenAI、硅基流动、智谱等兼容层）
 *  - `dashscope` ：阿里云百炼原生（万相是异步任务、CosyVoice 走 multimodal-generation）
 *
 * 上层（`/api/image`、`/api/tts`）只管「给提示词、拿图片/音频」，
 * 不关心是 b64 还是 url、是同步还是轮询。
 */

export class MediaError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code)
    this.name = 'MediaError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * 默认模型写死在这里，不让用户填。
 *
 * 理由：模型名是"厂商的版本号"，用户填 `qwen-plus` 这种半截名字只会换来 400；
 * 而图片、语音、文本本来就是三套模型，硬塞进一个输入框必然错配。
 * 需要换模型的人改 `config/app.yaml` 或环境变量，那是部署者的事。
 */
const OPENAI_IMAGE_MODEL = 'gpt-image-1'
const OPENAI_TTS_MODEL = 'tts-1'
/** 百炼：性价比最优的同步出图模型（无需轮询） */
const DASHSCOPE_IMAGE_MODEL = 'qwen-image-2.1-turbo'
/** 百炼：按字符计费、非实时合成的 TTS */
const DASHSCOPE_TTS_MODEL = 'qwen-audio-3.0-tts-flash'
/** 官方示例里的通用女声，作为未指定音色时的兜底 */
const DASHSCOPE_VOICE = 'longanhuan_v3.6'
const DASHSCOPE_NATIVE = 'https://dashscope.aliyuncs.com/api/v1'

/** qwen-image / qwen-audio 走同步接口；wanx / cosyvoice 走旧路径 */
const isQwenImage = (model) => /^qwen-image/i.test(model)
const isQwenTts = (model) => /^qwen-(audio|tts)/i.test(model)

/** 百炼原生接口不在兼容路径上：用户填的是 .../compatible-mode/v1 也要拉回来 */
/**
 * 百炼原生接口的根地址。
 *
 * 用户可能填三种写法，都要能收敛到 `${origin}/api/v1`：
 *   1. `https://dashscope.aliyuncs.com/compatible-mode/v1`（兼容模式，最常见的复制来源）
 *   2. `https://dashscope.aliyuncs.com/api/v1`（原生）
 *   3. `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1`（业务空间域名）
 *
 * 第 3 种**必须保留用户给的 host**：业务空间只在那个域名下有效，
 * 打回公有域名会 401/403。早前这里写死成公有域名，等于把用户填的地址悄悄丢掉。
 */
function dashscopeBase(baseUrl) {
  const raw = String(baseUrl || '').trim()
  if (!raw) return DASHSCOPE_NATIVE
  let url
  try {
    url = new URL(raw)
  } catch {
    return DASHSCOPE_NATIVE
  }
  // 已经带 /api/v1（可能多一个斜杠）
  if (/\/api\/v1\/?$/.test(url.pathname)) return `${url.origin}/api/v1`
  // compatible-mode/v1 或裸域名/其它路径：统一回 /api/v1
  if (!url.pathname || url.pathname === '/' || /compatible-mode/.test(url.pathname)) {
    return `${url.origin}/api/v1`
  }
  // 自建代理的自定义前缀：原样保留（去掉尾部斜杠）
  return raw.replace(/\/+$/, '')
}

/**
 * 多模态请求该打到哪、用谁的 Key。
 *
 * 这是「文本用 DeepSeek、图用百炼」的落点：两者的 base 与 key 可以完全不同。
 * 规则按「成对」来，不跨对拼接——否则会出现「站点的图床 + 用户的 Key」这种
 * 谁都算不清账、又多半会 401 的组合。
 *
 * @param {{
 *   clientBase?: string, clientKey?: string,
 *   clientLlmBase?: string, clientLlmKey?: string,
 *   siteBase?: string, siteKey?: string, llmBase?: string,
 * }} input
 * @returns {{ baseUrl: string, apiKey: string }}
 */
export function resolveMediaTarget(input = {}) {
  const {
    clientBase = '',
    clientKey = '',
    clientLlmBase = '',
    clientLlmKey = '',
    siteBase = '',
    siteKey = '',
    llmBase = '',
  } = input

  if (clientBase) {
    if (!clientKey) {
      throw new MediaError('E_NO_KEY', '填了多模态接口地址，还需要一个可用的 Key（它跟文本 Key 未必是同一把）')
    }
    return { baseUrl: clientBase, apiKey: clientKey }
  }
  if (siteBase && siteKey) return { baseUrl: siteBase, apiKey: siteKey }
  if (clientLlmBase && clientLlmKey) return { baseUrl: clientLlmBase, apiKey: clientLlmKey }
  if (llmBase && siteKey) return { baseUrl: llmBase, apiKey: siteKey }
  throw new MediaError('E_NO_KEY', '还没有可用的多模态接口与 Key，去设置里填一个')
}

export function pickProtocol(baseUrl) {
  const base = String(baseUrl || '')
  if (/dashscope/i.test(base)) return 'dashscope'
  // 业务空间域名形如 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`，不含 dashscope 字样。
  // 只按 dashscope 判断的话，这种地址会被当成 OpenAI 兼容，打到不存在的 /images/generations。
  if (/\.aliyuncs\.com/i.test(base)) return 'dashscope'
  return 'openai'
}

/** `1024x1024` → `1024*1024`（百炼用星号），其余协议保持不变 */
function dashscopeSize(size) {
  const m = /^(\d{2,4})\s*[x*×]\s*(\d{2,4})$/.exec(String(size ?? ''))
  if (!m) return '1024*1024'
  return `${m[1]}*${m[2]}`
}

async function toDataUrl(url, fetchImpl, signal) {
  const res = await fetchImpl(url, { signal })
  if (!res.ok) throw new MediaError('E_MEDIA_FAILED', `取回生成结果失败（${res.status}）`)
  const mime = (res.headers.get('content-type') || 'image/png').split(';')[0]
  const buf = Buffer.from(await res.arrayBuffer())
  return `data:${mime};base64,${buf.toString('base64')}`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 从上游错误体里抽一句能看懂的原因。
 *
 * 百炼/OpenAI 都习惯返回 `{code, message}`；拿不到就截断原文。
 * 只截 120 字并把换行压平——错误信息不该把日志或整页 HTML 灌给前端。
 */
function upstreamReason(detail) {
  const raw = String(detail ?? '').trim()
  if (!raw) return ''
  try {
    const data = JSON.parse(raw)
    const code = data?.code || data?.error?.code || ''
    const message = data?.message || data?.error?.message || data?.error || ''
    const text = [code, typeof message === 'string' ? message : ''].filter(Boolean).join(': ')
    if (text) return text.replace(/\s+/g, ' ').slice(0, 120)
  } catch {
    /* 不是 JSON，走下面的原文截断 */
  }
  return raw.replace(/\s+/g, ' ').slice(0, 120)
}

/**
 * 多模态自检：用**参数不全**的请求探一次鉴权。
 *
 * 为什么不是真的生成一张图：生成要花钱，而这里只想回答「Key 到底通不通」。
 * 上游的行为很稳定：Key 错 → 401/403；Key 对但参数缺 → 400/422（或业务码）。
 * 所以看到一个 400 就说明鉴权通过了——比让用户去猜「Key 不对」有用得多。
 *
 * @param {{ kind?: 'image'|'tts', baseUrl?: string, apiKey?: string, model?: string }} input
 */
export async function checkMediaAuth(input = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const { kind = 'image', baseUrl = '', apiKey = '', model = '' } = input
  const base = dashscopeBase(baseUrl)
  const protocol = pickProtocol(baseUrl)
  const picked =
    model ||
    (protocol === 'dashscope'
      ? kind === 'image'
        ? DASHSCOPE_IMAGE_MODEL
        : DASHSCOPE_TTS_MODEL
      : kind === 'image'
        ? OPENAI_IMAGE_MODEL
        : OPENAI_TTS_MODEL)

  if (!apiKey) return { ok: false, status: 0, reason: '没有可用的 Key', base, model: picked, protocol }

  const url =
    protocol === 'dashscope'
      ? kind === 'image'
        ? isQwenImage(picked)
          ? `${base}/services/aigc/multimodal-generation/generation`
          : `${base}/services/aigc/text2image/image-synthesis`
        : `${base}/services/audio/tts/SpeechSynthesizer`
      : `${base}${kind === 'image' ? '/images/generations' : '/audio/speech'}`

  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      // 故意只给 model：参数不全一定被拒，但鉴权会先过
      body: JSON.stringify({ model: picked }),
      signal: AbortSignal.timeout(15000),
    })
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return { ok: false, status: 0, reason: timeout ? '接口没有响应（地址或网络）' : '连不上接口', base, model: picked, protocol }
  }

  const text = await res.text().catch(() => '')
  const reason = upstreamReason(text)
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, reason: reason || 'Key 无效或与接口不匹配', base, model: picked, protocol }
  }
  if (res.status === 404) {
    return { ok: false, status: 404, reason: '这个接口没有该能力（地址或模型不对）', base, model: picked, protocol }
  }
  if (res.status === 429) {
    return { ok: true, status: 429, reason: 'Key 可用，但当前被限流', base, model: picked, protocol }
  }
  // 400/422 及任何「参数类」错误：鉴权已经通过——这正是我们要确认的
  return {
    ok: true,
    status: res.status,
    reason: res.ok ? '远端可用' : `鉴权通过（上游回了 ${res.status}：${reason || '参数错误'}）`,
    base,
    model: picked,
    protocol,
  }
}

export function createMedia(cfg = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  /** 轮询间隔可注入：测试不该真的等 1.4 秒 */
  const pollMs = deps.pollMs ?? 1400
  const media = cfg.media ?? {}

  function target(kind, overrideBase, overrideModel) {
    // 路由层已经用 `resolveMediaTarget` 定好地址；直接调用本模块时按配置回落
    const baseUrl = (overrideBase || media?.[kind]?.baseUrl || cfg.llm?.baseUrl || '').replace(/\/+$/, '')
    const protocol = pickProtocol(baseUrl)
    const model =
      overrideModel ||
      media?.[kind]?.model ||
      (protocol === 'dashscope'
        ? kind === 'image'
          ? DASHSCOPE_IMAGE_MODEL
          : DASHSCOPE_TTS_MODEL
        : kind === 'image'
          ? OPENAI_IMAGE_MODEL
          : OPENAI_TTS_MODEL)
    if (!baseUrl) throw new MediaError('E_NO_KEY', '还没有配置多模态接口地址')
    return { baseUrl, protocol, model }
  }

  function auth(apiKey) {
    const key = (apiKey || '').trim() || cfg.llm?.apiKey
    if (!key) throw new MediaError('E_NO_KEY', '还没有配置 API Key')
    return key
  }

  function mapStatus(status, detail) {
    // 上游的 code/message 必须带出来：401 可能是 Key 错、可能是模型没开通、
    // 也可能是国际站的 Key 打到了国内站。笼统写「Key 不对」会让人白查半小时。
    const why = upstreamReason(detail)
    const tail = why ? `（上游：${why}）` : ''
    if (status === 401) return new MediaError('E_UPSTREAM_AUTH', `Key 无效或与接口不匹配${tail}`)
    if (status === 403) {
      return new MediaError('E_UPSTREAM_AUTH', `这个 Key 没有该模型的权限，或账号未开通${tail}`)
    }
    if (status === 429) return new MediaError('E_RATE_LIMITED', `上游限流，稍等再试${tail}`)
    if (status === 404) {
      return new MediaError(
        'E_MEDIA_UNSUPPORTED',
        `这个接口不支持生图/语音。DeepSeek 只做文本，换百炼或 OpenAI 兼容的多模态接口${tail}`,
      )
    }
    return new MediaError('E_MEDIA_FAILED', `生图/语音失败（${status}）${tail}`)
  }

  async function postJson(url, body, headers, timeoutMs, signal) {
    let res
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new MediaError('E_UPSTREAM_TIMEOUT', '上游没有响应')
      }
      throw new MediaError('E_NETWORK', '连不上接口地址')
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw mapStatus(res.status, detail.slice(0, 160))
    }
    return res
  }

  /**
   * @param {{ prompt?: string, size?: string, apiKey?: string, baseUrl?: string, model?: string }} [input]
   */
  async function image(input = {}) {
    const { prompt, size = '1024x1024', apiKey, baseUrl, model: overrideModel } = input
    const text = String(prompt ?? '').trim().slice(0, 600)
    if (!text) throw new MediaError('E_BAD_REQUEST', '缺少画面描述')
    const key = auth(apiKey)
    const { baseUrl: base, protocol, model } = target('image', baseUrl, overrideModel)

    if (protocol === 'openai') {
      const res = await postJson(
        `${base}/images/generations`,
        { model, prompt: text, n: 1, size, response_format: 'b64_json' },
        { Authorization: `Bearer ${key}` },
        90000,
      )
      const data = await res.json().catch(() => null)
      const first = data?.data?.[0]
      if (first?.b64_json) return { image: `data:image/png;base64,${first.b64_json}`, model }
      if (first?.url) return { image: await toDataUrl(first.url, fetchImpl), model }
      throw new MediaError('E_MEDIA_FAILED', '接口没有返回图片')
    }

    // 百炼 · qwen-image：同步返回，一次调用拿图
    if (isQwenImage(model)) {
      const res = await postJson(
        `${dashscopeBase(base)}/services/aigc/multimodal-generation/generation`,
        {
          model,
          input: { messages: [{ role: 'user', content: [{ text }] }] },
          parameters: { size: dashscopeSize(size), n: 1, prompt_extend: true },
        },
        { Authorization: `Bearer ${key}` },
        120000,
      )
      const body = await res.json().catch(() => null)
      const url = body?.output?.choices?.[0]?.message?.content?.[0]?.image
      if (url) return { image: await toDataUrl(url, fetchImpl), model }
      throw new MediaError('E_MEDIA_FAILED', body?.message || '接口没有返回图片')
    }

    // 百炼 · 万相：提交异步任务 → 轮询 → 取图
    const submit = await postJson(
      `${dashscopeBase(base)}/services/aigc/text2image/image-synthesis`,
      {
        model,
        input: { prompt: text },
        parameters: { size: dashscopeSize(size), n: 1 },
      },
      { Authorization: `Bearer ${key}`, 'X-DashScope-Async': 'enable' },
      30000,
    )
    const taskId = (await submit.json().catch(() => null))?.output?.task_id
    if (!taskId) throw new MediaError('E_MEDIA_FAILED', '百炼没有返回任务号')

    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      await sleep(pollMs)
      const poll = await fetchImpl(`${dashscopeBase(base)}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20000),
      })
      if (!poll.ok) throw mapStatus(poll.status, '')
      const out = (await poll.json().catch(() => null))?.output
      if (out?.task_status === 'SUCCEEDED') {
        const url = out.results?.[0]?.url
        if (!url) throw new MediaError('E_MEDIA_FAILED', '任务成功但没有图片地址')
        return { image: await toDataUrl(url, fetchImpl), model }
      }
      if (out?.task_status === 'FAILED') {
        throw new MediaError('E_MEDIA_FAILED', out?.message || '生成失败（可能触发了内容审核）')
      }
    }
    throw new MediaError('E_UPSTREAM_TIMEOUT', '等图超时（90 秒），稍后重试')
  }

  /**
   * @param {{ text?: string, voice?: string, speed?: number, apiKey?: string, baseUrl?: string, model?: string }} [input]
   */
  async function speech(input = {}) {
    const { text, voice, speed, apiKey, baseUrl, model: overrideModel } = input
    const content = String(text ?? '').trim().slice(0, 900)
    if (!content) throw new MediaError('E_BAD_REQUEST', '没有要读的内容')
    const key = auth(apiKey)
    const { baseUrl: base, protocol, model } = target('tts', baseUrl, overrideModel)
    const rate = Math.min(2, Math.max(0.5, Number(speed) || 1))

    if (protocol === 'openai') {
      const res = await postJson(
        `${base}/audio/speech`,
        {
          model,
          voice: voice || 'alloy',
          input: content,
          response_format: 'mp3',
          speed: rate,
        },
        { Authorization: `Bearer ${key}` },
        60000,
      )
      const buf = Buffer.from(await res.arrayBuffer())
      return { audio: `data:audio/mpeg;base64,${buf.toString('base64')}`, model }
    }

    // 百炼 · qwen-audio-tts：同步合成，返回 24 小时有效的音频地址
    if (isQwenTts(model)) {
      const res = await postJson(
        `${dashscopeBase(base)}/services/audio/tts/SpeechSynthesizer`,
        {
          model,
          input: {
            text: content,
            voice: voice || DASHSCOPE_VOICE,
            format: 'mp3',
            rate,
          },
        },
        { Authorization: `Bearer ${key}` },
        90000,
      )
      const body = await res.json().catch(() => null)
      const url = body?.output?.audio?.url
      if (!url) throw new MediaError('E_MEDIA_FAILED', body?.message || '接口没有返回音频')
      return { audio: await toDataUrl(url, fetchImpl), model }
    }

    // 百炼 · CosyVoice：老路径，保留给自建/历史配置
    const res = await postJson(
      `${dashscopeBase(base)}/services/aigc/multimodal-generation/generation`,
      {
        model,
        input: { text: content, voice: voice || 'longxiaochun', format: 'mp3', rate },
      },
      { Authorization: `Bearer ${key}` },
      60000,
    )
    const url = (await res.json().catch(() => null))?.output?.audio?.url
    if (!url) throw new MediaError('E_MEDIA_FAILED', '接口没有返回音频')
    return { audio: await toDataUrl(url, fetchImpl), model }
  }

  return { image, speech }
}
