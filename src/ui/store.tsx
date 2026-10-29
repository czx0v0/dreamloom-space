/** 全局上下文：仓储、配置、BYOK 密钥。 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createNarrator } from '../agents/narrator'
import { createArchivist } from '../agents/archivist'
import { createSeeder } from '../agents/seeder'
import { createRewriter } from '../agents/rewriter'
import { createTriage } from '../agents/triage'
import { createDream } from '../agents/dream'
import { createSuggest } from '../agents/suggest'
import { createPing } from '../agents/ping'
import { createMedia } from '../agents/media'
import { fetchConfig, type ClientConfig } from '../app/config'
import { createIdbKv } from '../store/kv'
import { createRepo, type SpaceRepo } from '../store/repo'

const KEY_STORAGE = 'dreamloom.llmKey'
/** 上游接口：只存本机。留空则用服务端配置（部署者自己的 key） */
const PROVIDER_STORAGE = 'dreamloom.llmProvider'

export interface LlmProvider {
  baseUrl: string
  model: string
  /** 默认（女声）朗读音色，留空用供应商默认 */
  ttsVoice?: string
  /** 男声音色；留空则男角色也走默认（会提示性别可能不符） */
  ttsVoiceMale?: string
  /** 多模态接口地址（生图/语音）；留空 = 与文本同一个接口 */
  mediaBase?: string
  /** 多模态 Key；留空 = 与文本同一把 */
  mediaKey?: string
}

const EMPTY_PROVIDER: LlmProvider = { baseUrl: '', model: '', ttsVoice: '', mediaBase: '', mediaKey: '' }

function loadProvider(): LlmProvider {
  try {
    const raw = localStorage.getItem(PROVIDER_STORAGE)
    if (!raw) return EMPTY_PROVIDER
    const data = JSON.parse(raw) as Partial<LlmProvider>
    return {
      baseUrl: typeof data.baseUrl === 'string' ? data.baseUrl : '',
      model: typeof data.model === 'string' ? data.model : '',
      ttsVoice: typeof data.ttsVoice === 'string' ? data.ttsVoice : '',
      ttsVoiceMale: typeof data.ttsVoiceMale === 'string' ? data.ttsVoiceMale : '',
      mediaBase: typeof data.mediaBase === 'string' ? data.mediaBase : '',
      mediaKey: typeof data.mediaKey === 'string' ? data.mediaKey : '',
    }
  } catch {
    return EMPTY_PROVIDER
  }
}

export interface AppContextValue {
  repo: SpaceRepo
  config: ClientConfig
  narrator: ReturnType<typeof createNarrator>
  archivist: ReturnType<typeof createArchivist>
  seeder: ReturnType<typeof createSeeder>
  rewriter: ReturnType<typeof createRewriter>
  triage: ReturnType<typeof createTriage>
  dream: ReturnType<typeof createDream>
  suggest: ReturnType<typeof createSuggest>
  ping: ReturnType<typeof createPing>
  media: ReturnType<typeof createMedia>
  apiKey: string
  setApiKey: (key: string) => void
  provider: LlmProvider
  setProvider: (next: LlmProvider) => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [repo, setRepo] = useState<SpaceRepo | null>(null)
  const [config, setConfig] = useState<ClientConfig | null>(null)
  const [apiKey, setApiKeyState] = useState(() => localStorage.getItem(KEY_STORAGE) ?? '')
  const [provider, setProviderState] = useState<LlmProvider>(loadProvider)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [kv, cfg] = await Promise.all([createIdbKv(), fetchConfig()])
        if (!alive) return
        setRepo(createRepo({ kv, now: () => Date.now() }))
        setConfig(cfg)
      } catch (e) {
        setError(e instanceof Error ? e.message : '初始化失败')
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const setApiKey = (key: string) => {
    const trimmed = key.trim()
    setApiKeyState(trimmed)
    if (trimmed) localStorage.setItem(KEY_STORAGE, trimmed)
    else localStorage.removeItem(KEY_STORAGE)
  }

  const setProvider = (next: LlmProvider) => {
    const clean = {
      baseUrl: next.baseUrl.trim(),
      model: next.model.trim(),
      ttsVoice: (next.ttsVoice ?? '').trim(),
      ttsVoiceMale: (next.ttsVoiceMale ?? '').trim(),
      mediaBase: (next.mediaBase ?? '').trim(),
      mediaKey: (next.mediaKey ?? '').trim(),
    }
    setProviderState(clean)
    if (clean.baseUrl || clean.model || clean.ttsVoice || clean.mediaBase || clean.mediaKey)
      localStorage.setItem(PROVIDER_STORAGE, JSON.stringify(clean))
    else localStorage.removeItem(PROVIDER_STORAGE)
  }

  const value = useMemo<AppContextValue | null>(() => {
    if (!repo || !config) return null
    const options = {
      apiKey,
      providerBase: provider.baseUrl || undefined,
      model: provider.model || undefined,
      mediaBase: provider.mediaBase || undefined,
      mediaKey: provider.mediaKey || undefined,
    }
    return {
      repo,
      config,
      narrator: createNarrator(options),
      archivist: createArchivist(options),
      seeder: createSeeder(options),
      rewriter: createRewriter(options),
      triage: createTriage(options),
      dream: createDream(options),
      suggest: createSuggest(options),
      ping: createPing(options),
      media: createMedia(options),
      apiKey,
      setApiKey,
      provider,
      setProvider,
    }
  }, [repo, config, apiKey, provider])

  if (error) return <div className="boot boot-error">初始化失败：{error}</div>
  if (!value) return <div className="boot">正在打开书架…</div>

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp 必须在 AppProvider 内使用')
  return value
}
