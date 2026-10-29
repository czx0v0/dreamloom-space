/** 全局设置：外观、生成默认值、模型与密钥。 */

import { useState } from 'react'
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
  const { config, apiKey, setApiKey } = useApp()
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [keyDraft, setKeyDraft] = useState(apiKey)
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

      <section className="panel">
        <h3>模型</h3>
        <dl className="kv">
          <dt>当前模型</dt>
          <dd>{config.mock ? '演示回放（LLM_MOCK=1）' : config.model || '（未配置）'}</dd>
          <dt>服务端 Key</dt>
          <dd>{config.hasServerKey ? '已配置（.env）' : '未配置'}</dd>
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
      </section>
    </div>
  )
}
