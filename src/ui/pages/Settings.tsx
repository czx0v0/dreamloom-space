/** 全局设置：外观、生成默认值、模型与密钥。 */

import { useState } from 'react'
import { toUserMessage } from '../../domain/errors'
import type { CharPreset } from '../../domain/types'
import { navigate } from '../router'
import { useApp } from '../store'
import {
  FONT_SCALES,
  THEME_LABEL,
  applyPrefs,
  loadPrefs,
  savePrefs,
  type Prefs,
  type Theme,
} from '../prefs'

const THEMES: Theme[] = ['paper', 'cool', 'dark']
const PRESETS: Array<{ value: CharPreset; label: string }> = [
  { value: 'short', label: '短' },
  { value: 'medium', label: '中' },
  { value: 'long', label: '长' },
]

export function Settings() {
  const { config, apiKey, setApiKey, provider, setProvider, ping, media } = useApp()
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [keyDraft, setKeyDraft] = useState(apiKey)
  const [providerDraft, setProviderDraft] = useState(provider)
  /** 测试连接的结果：成功显示模型与耗时，失败显示具体原因 */
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null)
  const [probing, setProbing] = useState(false)
  /** 多模态自检：出一张最小的图 / 说一句最短的话，确认这条链路是通的 */
  const [mediaTry, setMediaTry] = useState<{ kind: 'image' | 'tts'; busy: boolean; ok: boolean; text: string; src?: string } | null>(null)

  const tryMedia = async (kind: 'image' | 'tts') => {
    setMediaTry({ kind, busy: true, ok: false, text: '' })
    try {
      if (kind === 'image') {
        const r = await media.draw({ prompt: '一张极简的测试卡：米白纸面，中央一枚墨点', size: '512x512' })
        setMediaTry({ kind, busy: false, ok: true, text: `出图成功 · ${r.model} · ${r.ms} ms`, src: r.image })
      } else {
        const r = await media.speak({ text: '雾散了，我们走吧。', voice: providerDraft.ttsVoice || undefined })
        setMediaTry({ kind, busy: false, ok: true, text: `语音合成成功 · ${r.model} · ${r.ms} ms`, src: r.audio })
      }
    } catch (e) {
      setMediaTry({ kind, busy: false, ok: false, text: toUserMessage(e) })
    }
  }
  const [mediaCheck, setMediaCheck] = useState<{
    image: { ok: boolean; text: string }
    tts: { ok: boolean; text: string }
  } | null>(null)
  const [checkingMedia, setCheckingMedia] = useState(false)
  const [saved, setSaved] = useState('')

  const update = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    savePrefs(next)
    applyPrefs(next)
  }

  const flash = (text: string) => {
    setSaved(text)
    window.setTimeout(() => setSaved(''), 1800)
  }

  const range = (preset: CharPreset) => {
    const r = config.presets[preset]
    return r ? `${r.min}–${r.max} 字` : ''
  }

  return (
    <div className="page settings">
      <header className="shelf-head">
        <div>
          <button className="link" onClick={() => navigate('')}>
            ← 书架
          </button>
          <h1>设置</h1>
          <p className="muted">只影响这台设备，不写进故事存档。</p>
        </div>
        {saved && <span className="notice ok inline">{saved}</span>}
      </header>

      <section className="panel">
        <h3>外观</h3>

        <div className="field">
          <span className="field-label">配色</span>
          <div className="seg">
            {THEMES.map((t) => (
              <button
                key={t}
                className={prefs.theme === t ? 'seg-item active' : 'seg-item'}
                onClick={() => update({ theme: t })}
              >
                {THEME_LABEL[t]}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">正文大小</span>
          <div className="seg">
            {FONT_SCALES.map((f) => (
              <button
                key={f.value}
                className={prefs.fontScale === f.value ? 'seg-item active' : 'seg-item'}
                onClick={() => update({ fontScale: f.value })}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <p className="muted small">下面这段用来预览当前效果，改动即时生效。</p>
        <div className="panel preview">
          <div className="rich">
            <p className="line">雾从门缝里挤进来，在地板上摊成薄薄一层。</p>
            <p className="line dialog">「你迟到了。」</p>
            <p className="line">
              他终于<strong>推开门</strong>了。
            </p>
          </div>
        </div>
      </section>

      <section className="panel">
        <h3>新建空间的默认值</h3>
        <p className="muted small">
          只作用于之后新建的空间。已有空间在编织台里单独调。
        </p>

        <div className="field">
          <span className="field-label">篇幅</span>
          <div className="seg">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                className={prefs.preset === p.value ? 'seg-item active' : 'seg-item'}
                onClick={() => update({ preset: p.value })}
              >
                {p.label} · {range(p.value)}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">温度</span>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            value={prefs.temperature}
            onChange={(e) => update({ temperature: Number(e.target.value) })}
          />
          <span className="mono small">{prefs.temperature.toFixed(2)}</span>
          <span className="muted small">越高越发散，偏低更稳但容易复读</span>
        </div>

        <div className="field">
          <span className="field-label">选项数</span>
          <div className="seg">
            {[0, 2, 3, 4].map((n) => (
              <button
                key={n}
                className={prefs.choiceCount === n ? 'seg-item active' : 'seg-item'}
                onClick={() => update({ choiceCount: n })}
              >
                {n === 0 ? '不生成' : `${n} 个`}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="panel privacy-panel">
        <h3>数据与隐私</h3>
        <ul className="plain small">
          <li>
            <strong>只存在这台设备。</strong>
            世界、人物、正文、伏笔、生成图全部存在浏览器本地（IndexedDB），
            <strong>不会上传、不会云端同步、也没有账号系统</strong>。
          </li>
          <li>
            <strong>换设备请用导出。</strong>
            在「导出」页存一份「存档 JSON」，到新设备用「导入存档」读进来；
            清浏览器数据、换浏览器、无痕模式都会读不到原来的内容。
          </li>
          <li>
            <strong>Key 只在本机。</strong>
            填的 Key 存在浏览器里，请求时随请求头转发给模型供应商，服务端不落盘、不写日志。
          </li>
          <li>
            <strong>会发出去的东西：</strong>
            写作时的上下文（世界设定、人物、摘要、正文片段）与生图提示词会发给你配置的模型供应商；
            这是生成内容的必要条件，除此之外不发任何数据。
          </li>
        </ul>
      </section>

      <section className="panel">
        <h3>模型</h3>
        <dl className="kv">
          <dt>当前模型</dt>
          <dd>{config.mock ? '演示回放（内置样例）' : config.model || '（未配置）'}</dd>
          <dt>服务端 Key</dt>
          <dd>{config.hasServerKey ? '已由站点配置（可直接用）' : '未配置'}</dd>
          <dt>本机 Key</dt>
          <dd>{apiKey ? '已保存，仅这台设备' : '未保存'}</dd>
        </dl>

        <div className="field">
          <span className="field-label">API Key</span>
          <input
            type="password"
            autoComplete="off"
            placeholder="sk-…（留空则用服务端的）"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
          />
          <button
            className="btn ghost small-btn"
            onClick={() => {
              const trimmed = keyDraft.trim()
              setApiKey(trimmed)
              flash(trimmed ? '已保存到本机' : '已清除本机 Key')
            }}
          >
            保存
          </button>
        </div>
        <p className="muted small">
          只存在这台设备的浏览器里，请求时随 <code>x-llm-key</code> 头发给后端转发，不写入任何服务器。
        </p>

        <h3>接口地址与模型</h3>
        <p className="muted small">
          同样只存本机。留空就用服务端默认；填了就按你的走（服务端只放行 DeepSeek / 阿里云百炼 /
          OpenAI 这几个域名，避免它变成任意 URL 的代理）。
        </p>
        <div className="provider-presets">
          {[
            {
              label: 'DeepSeek',
              baseUrl: 'https://api.deepseek.com/v1',
              model: 'deepseek-chat',
            },
            {
              label: '阿里云百炼（DashScope 兼容模式）',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              model: 'qwen-plus',
            },
          ].map((p) => (
            <button
              key={p.label}
              className="btn ghost small-btn"
              onClick={() => setProviderDraft({ baseUrl: p.baseUrl, model: p.model })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="field">
          <span className="field-label">Base URL</span>
          <input
            value={providerDraft.baseUrl}
            placeholder="https://api.deepseek.com/v1"
            onChange={(e) => setProviderDraft({ ...providerDraft, baseUrl: e.target.value })}
          />
        </div>
        <div className="field">
          <span className="field-label">模型名</span>
          <input
            value={providerDraft.model}
            placeholder="deepseek-chat / qwen-plus"
            onChange={(e) => setProviderDraft({ ...providerDraft, model: e.target.value })}
          />
        </div>
        <h3>生图与语音（可选）</h3>
        <p className="muted small">
          文本与图片/语音通常是<strong>不同厂商的不同模型</strong>：文本可以用 DeepSeek，图和声音要另外配。
          这里留空就沿用上面的接口；填了就只用于生图与朗读。模型由服务端按接口自动选，
          不用填版本号（填 <code>qwen-plus</code> 这种半截名字只会换回 400）。
        </p>
        <div className="field">
          <span className="field-label">接口地址</span>
          <input
            value={providerDraft.mediaBase ?? ''}
            placeholder="https://dashscope.aliyuncs.com/api/v1"
            onChange={(e) => setProviderDraft({ ...providerDraft, mediaBase: e.target.value })}
          />
        </div>
        <div className="field">
          <span className="field-label">多模态 Key</span>
          <input
            type="password"
            autoComplete="off"
            value={providerDraft.mediaKey ?? ''}
            placeholder="留空 = 用上面的 Key"
            onChange={(e) => setProviderDraft({ ...providerDraft, mediaKey: e.target.value })}
          />
        </div>
        <div className="field">
          <span className="field-label">朗读音色</span>
          <input
            value={providerDraft.ttsVoice ?? ''}
            placeholder="女声，留空用默认（longanhuan_v3.6）"
            onChange={(e) => setProviderDraft({ ...providerDraft, ttsVoice: e.target.value })}
          />
        </div>
        <div className="field">
          <span className="field-label">男声音色</span>
          <input
            value={providerDraft.ttsVoiceMale ?? ''}
            placeholder="男声（音色名见控制台列表）"
            onChange={(e) => setProviderDraft({ ...providerDraft, ttsVoiceMale: e.target.value })}
          />
        </div>
        <p className="muted small">
          默认音色是女声。角色档案里标了「男」而这里没填男声，朗读会用女声念男角色的话——所以两者最好一起配。
        </p>
        <p className="muted small">
          默认模型：出图 <code>qwen-image-2.1-turbo</code>、朗读 <code>qwen-audio-3.0-tts-flash</code>。
          换成万相或 CosyVoice 时服务端会自己切到异步/老路径，不需要你改参数。
        </p>
        <div className="row">
          <button
            className="btn ghost small-btn"
            disabled={mediaTry?.busy}
            onClick={() => void tryMedia('image')}
            title="出一张 512 的小图，确认出图链路（会消耗一次额度）"
          >
            {mediaTry?.busy && mediaTry.kind === 'image' ? '出图中…' : '试一张图'}
          </button>
          <button
            className="btn ghost small-btn"
            disabled={mediaTry?.busy}
            onClick={() => void tryMedia('tts')}
            title="朗读一句 8 个字，确认语音链路（会消耗一次额度）"
          >
            {mediaTry?.busy && mediaTry.kind === 'tts' ? '合成中…' : '试一句语音'}
          </button>
        </div>
        {mediaTry && !mediaTry.busy && (
          <div className={mediaTry.ok ? 'notice ok' : 'notice error'}>
            {mediaTry.ok ? '✓ ' : '✕ '}
            {mediaTry.text}
            {mediaTry.ok && mediaTry.kind === 'image' && mediaTry.src && (
              <img className="media-preview" src={mediaTry.src} alt="出图测试" />
            )}
            {mediaTry.ok && mediaTry.kind === 'tts' && mediaTry.src && (
              <audio className="media-preview-audio" controls src={mediaTry.src} />
            )}
          </div>
        )}
        <div className="row">
          <button
            className="btn ghost small-btn"
            disabled={checkingMedia}
            onClick={() => {
              setCheckingMedia(true)
              setMediaCheck(null)
              void media
                .check({
                  imageBase: providerDraft.mediaBase?.trim() || undefined,
                  imageKey: providerDraft.mediaKey?.trim() || undefined,
                  ttsBase: providerDraft.mediaBase?.trim() || undefined,
                  ttsKey: providerDraft.mediaKey?.trim() || undefined,
                })
                .then((r) =>
                  setMediaCheck({
                    image: {
                      ok: r.image.ok,
                      text: `${r.image.ok ? '可用' : '不可用'} · ${r.image.base} · ${r.image.model} · Key 来源 ${r.image.keySource}${r.image.keyTail}${r.image.reason ? ` · ${r.image.reason}` : ''}`,
                    },
                    tts: {
                      ok: r.tts.ok,
                      text: `${r.tts.ok ? '可用' : '不可用'} · ${r.tts.base} · ${r.tts.model} · Key 来源 ${r.tts.keySource}${r.tts.keyTail}${r.tts.reason ? ` · ${r.tts.reason}` : ''}`,
                    },
                  }),
                )
                .catch((e) =>
                  setMediaCheck({
                    image: { ok: false, text: toUserMessage(e) },
                    tts: { ok: false, text: '同上' },
                  }),
                )
                .finally(() => setCheckingMedia(false))
            }}
          >
            {checkingMedia ? '检查中…' : '自检生图 / 语音'}
          </button>
          <span className="muted small">不生成图片、不计费，只探一次鉴权</span>
        </div>
        {mediaCheck && (
          <div className="media-check">
            <p className={mediaCheck.image.ok ? 'ok-line' : 'bad-line'}>
              {mediaCheck.image.ok ? '✓ 生图' : '✕ 生图'}：{mediaCheck.image.text}
            </p>
            <p className={mediaCheck.tts.ok ? 'ok-line' : 'bad-line'}>
              {mediaCheck.tts.ok ? '✓ 朗读' : '✕ 朗读'}：{mediaCheck.tts.text}
            </p>
          </div>
        )}
        <div className="row">
          <button
            className="btn primary small-btn"
            onClick={() => {
              setProvider(providerDraft)
              flash('接口设置已保存到本机')
            }}
          >
            保存接口设置
          </button>
          <button
            className="btn ghost small-btn"
            disabled={probing}
            onClick={() => {
              // 用**草稿**去测：先存再测的话，错了还得改回来
              setProbing(true)
              setProbe(null)
              void ping
                .check({
                  apiKey: keyDraft.trim() || undefined,
                  providerBase: providerDraft.baseUrl.trim() || undefined,
                  model: providerDraft.model.trim() || undefined,
                })
                .then((r) =>
                  setProbe({
                    ok: true,
                    text: `连接成功 · ${r.model} · ${r.ms} ms${r.endpoint && r.endpoint !== 'mock' ? ` · ${r.endpoint}` : ''}`,
                  }),
                )
                .catch((e) =>
                  setProbe({
                    ok: false,
                    text: `${toUserMessage(e)}（401 = Key 错；404 = Base URL 少了 /v1；其余见下方说明）`,
                  }),
                )
                .finally(() => setProbing(false))
            }}
          >
            {probing ? '测试中…' : '测试连接'}
          </button>
          <button
            className="btn ghost small-btn"
            onClick={() => {
              setProviderDraft({ baseUrl: '', model: '' })
              setProvider({ baseUrl: '', model: '' })
              flash('已改回服务端默认')
            }}
          >
            用服务端默认
          </button>
        </div>
        {probe && (
          <div className={probe.ok ? 'notice ok probe-result' : 'notice error probe-result'}>
            {probe.ok ? '✓ ' : '✕ '}
            {probe.text}
          </div>
        )}
        <details className="hints">
          <summary>怎么拿到 Key（两步）</summary>
          <ol className="plain small">
            <li>
              DeepSeek：登录 platform.deepseek.com → API Keys → 新建，复制 <code>sk-…</code>；
              接口地址填 <code>https://api.deepseek.com/v1</code>，模型填 <code>deepseek-chat</code>。
            </li>
            <li>
              阿里云百炼：登录 bailian.console.aliyun.com → API-KEY 管理 → 新建；
              接口地址填 <code>https://dashscope.aliyuncs.com/compatible-mode/v1</code>，
              模型填 <code>qwen-plus</code>（或 <code>qwen-max</code>）。
            </li>
          </ol>
          <p className="muted small">
            填完先回书架新建一个空间试一句。报 401 是 Key 错，报 404 多半是 Base URL 少了 <code>/v1</code>。
          </p>
        </details>
      </section>
    </div>
  )
}
