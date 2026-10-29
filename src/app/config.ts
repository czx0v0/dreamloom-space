/** 客户端配置：`/api/config` 的形状，服务端 `getPublicConfig()` 是唯一来源。 */

import type { CharRange } from '../domain/types'

export interface ClientConfig {
  appName: string
  model: string
  presets: Record<string, CharRange>
  defaultPreset: string
  choiceCount: number
  temperature: number
  features: { tts: boolean; image: boolean; dream: boolean; economy: boolean }
  /** 站点是否自带多模态能力（用户自带 Key 时另算） */
  media: { image: boolean; tts: boolean }
  limits: {
    narrateRpm: number
    structuredRpm: number
    maxConcurrency: number
    maxOutputChars: number
  }
  budget: {
    contentBudget: number
    sections: Record<string, number>
    overhead: { persona: number; format: number }
    trimOrder: string[]
    pinned: string[]
    maxCast: number
    maxPlaces: number
    maxRelations: number
    maxClues: number
    recentSummaries: number
    maxArc: number
    maxPlaceEvents: number
    maxFacts: number
  maxOpenClues: number
    promptFacts: number
  }
  recall: {
    enabled: boolean
    mode: 'keyword' | 'vector'
    topK: number
    keep: number
    minScore: number
    embedding: { source: string; model: string; dim: number; device: string }
  }
  hasServerKey: boolean
  mock: boolean
  promptOverhead?: { persona: number; format: number }
}

export const FALLBACK_CONFIG: ClientConfig = {
  appName: '筑梦之境',
  model: '(未配置)',
  presets: {
    short: { min: 200, max: 320 },
    medium: { min: 320, max: 500 },
    long: { min: 500, max: 800 },
  },
  defaultPreset: 'short',
  choiceCount: 4,
  temperature: 0.9,
  features: { tts: false, image: false, dream: true, economy: false },
  media: { image: false, tts: false },
  limits: { narrateRpm: 8, structuredRpm: 20, maxConcurrency: 2, maxOutputChars: 2500 },
  budget: {
    contentBudget: 4900,
    sections: {},
    overhead: { persona: 900, format: 400 },
    trimOrder: ['places', 'relations', 'clues', 'summaries', 'cast', 'lastTail', 'outline', 'recall', 'placeEvents', 'arcs', 'facts'],
    pinned: ['rules', 'action'],
    maxCast: 8,
    maxPlaces: 4,
    maxRelations: 10,
    maxClues: 8,
    recentSummaries: 8,
    maxArc: 12,
    maxPlaceEvents: 12,
    maxFacts: 40,
    maxOpenClues: 12,
    promptFacts: 10,
  },
  recall: {
    enabled: true,
    mode: 'keyword',
    topK: 6,
    keep: 4,
    minScore: 0.32,
    embedding: { source: 'hf', model: 'Xenova/bge-small-zh-v1.5', dim: 512, device: 'wasm' },
  },
  hasServerKey: false,
  mock: false,
}

export async function fetchConfig(baseUrl = ''): Promise<ClientConfig> {
  try {
    const res = await fetch(`${baseUrl}/api/config`)
    if (!res.ok) return FALLBACK_CONFIG
    const data = (await res.json()) as Partial<ClientConfig>
    return {
      ...FALLBACK_CONFIG,
      ...data,
      budget: { ...FALLBACK_CONFIG.budget, ...(data.budget ?? {}) },
      recall: { ...FALLBACK_CONFIG.recall, ...(data.recall ?? {}) },
      limits: { ...FALLBACK_CONFIG.limits, ...(data.limits ?? {}) },
    }
  } catch {
    return FALLBACK_CONFIG
  }
}
