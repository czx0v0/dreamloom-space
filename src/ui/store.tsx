/** 全局上下文：仓储、配置、BYOK 密钥。 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createNarrator } from '../agents/narrator'
import { createArchivist } from '../agents/archivist'
import { createSeeder } from '../agents/seeder'
import { createRewriter } from '../agents/rewriter'
import { createTriage } from '../agents/triage'
import { fetchConfig, type ClientConfig } from '../app/config'
import { createIdbKv } from '../store/kv'
import { createRepo, type SpaceRepo } from '../store/repo'

const KEY_STORAGE = 'dreamloom.llmKey'

export interface AppContextValue {
  repo: SpaceRepo
  config: ClientConfig
  narrator: ReturnType<typeof createNarrator>
  archivist: ReturnType<typeof createArchivist>
  seeder: ReturnType<typeof createSeeder>
  rewriter: ReturnType<typeof createRewriter>
  triage: ReturnType<typeof createTriage>
  apiKey: string
  setApiKey: (key: string) => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [repo, setRepo] = useState<SpaceRepo | null>(null)
  const [config, setConfig] = useState<ClientConfig | null>(null)
  const [apiKey, setApiKeyState] = useState(() => localStorage.getItem(KEY_STORAGE) ?? '')
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

  const value = useMemo<AppContextValue | null>(() => {
    if (!repo || !config) return null
    const options = { apiKey }
    return {
      repo,
      config,
      narrator: createNarrator(options),
      archivist: createArchivist(options),
      seeder: createSeeder(options),
      rewriter: createRewriter(options),
      triage: createTriage(options),
      apiKey,
      setApiKey,
    }
  }, [repo, config, apiKey])

  if (error) return <div className="boot boot-error">初始化失败：{error}</div>
  if (!value) return <div className="boot">正在打开书架…</div>

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp 必须在 AppProvider 内使用')
  return value
}
