/**
 * 配置装载：config/app.yaml + 环境变量，服务端唯一入口。
 * 前端永远不解析 YAML，只拿 getPublicConfig() 的 JSON 子集。
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(__dirname, '..')

/** 依次尝试 .env.local / .env，使用 Node 内置能力，不引 dotenv。 */
function loadEnvFiles() {
  if (typeof process.loadEnvFile !== 'function') return
  for (const name of ['.env.local', '.env']) {
    const p = join(ROOT, name)
    if (!existsSync(p)) continue
    try {
      process.loadEnvFile(p)
    } catch {
      /* 环境变量文件格式有问题时静默跳过，不让启动失败 */
    }
  }
}
loadEnvFiles()

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))
const num = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function readYaml() {
  const p = join(ROOT, 'config', 'app.yaml')
  if (!existsSync(p)) return {}
  return parseYaml(readFileSync(p, 'utf8')) ?? {}
}

const raw = readYaml()

const appCfg = raw.app ?? {}
const llmCfg = raw.llm ?? {}
const narrativeCfg = raw.narrative ?? {}
const budgetCfg = raw.budget ?? {}
const rateCfg = raw.ratelimit ?? {}
const featureCfg = raw.features ?? {}
const evalCfg = raw.eval ?? {}
const recallCfg = raw.recall ?? {}

export const MOCK = process.env.LLM_MOCK === '1'

export const config = {
  appName: appCfg.name ?? '筑梦之境',
  port: clamp(num(process.env.PORT, 3000), 1, 65535),
  dailyCharBudget: clamp(num(process.env.DAILY_CHAR_BUDGET, appCfg.dailyCharBudget ?? 1000000), 1000, 50000000),
  accessToken: process.env.APP_ACCESS_TOKEN ?? appCfg.accessToken ?? '',

  llm: {
    baseUrl: (process.env.LLM_BASE_URL ?? llmCfg.baseUrl ?? '').replace(/\/+$/, ''),
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? llmCfg.model ?? '',
    temperature: {
      narrator: clamp(num(llmCfg.temperature?.narrator, 0.9), 0, 1.5),
      archivist: clamp(num(llmCfg.temperature?.archivist, 0.1), 0, 0.6),
      judge: clamp(num(llmCfg.temperature?.judge, 0), 0, 0.3),
    },
    maxOutputChars: {
      narrator: clamp(num(llmCfg.maxOutputChars?.narrator, 2500), 200, 8000),
      archivist: clamp(num(llmCfg.maxOutputChars?.archivist, 1200), 200, 8000),
    },
    timeouts: {
      firstByteMs: clamp(num(llmCfg.timeouts?.firstByteMs, 20000), 1000, 120000),
      idleMs: clamp(num(llmCfg.timeouts?.idleMs, 30000), 1000, 180000),
      totalNarrateMs: clamp(num(llmCfg.timeouts?.totalNarrateMs, 120000), 5000, 600000),
      totalStructuredMs: clamp(num(llmCfg.timeouts?.totalStructuredMs, 45000), 3000, 300000),
      repairMs: clamp(num(llmCfg.timeouts?.repairMs, 20000), 2000, 120000),
    },
    retry: {
      // 0..5：重试太多次会让一次失败拖到一分钟以上，用户会以为卡死
      maxAttempts: clamp(num(llmCfg.retry?.maxAttempts, 3), 0, 5),
      backoffMs: clamp(num(llmCfg.retry?.backoffMs, 500), 0, 5000),
    },
  },

  narrative: {
    presets: {
      short: { min: 300, max: 450 },
      medium: { min: 450, max: 700 },
      long: { min: 700, max: 1200 },
      ...(narrativeCfg.presets ?? {}),
    },
    defaultPreset: narrativeCfg.defaultPreset ?? 'medium',
    choiceCount: clamp(num(narrativeCfg.choiceCount, 3), 0, 5),
    actionVerbs: Array.isArray(narrativeCfg.actionVerbs) ? narrativeCfg.actionVerbs : [],
  },

  budget: {
    narrator: {
      totalInput: clamp(num(budgetCfg.narrator?.totalInput, 6200), 1200, 128000),
      overhead: {
        persona: clamp(num(budgetCfg.narrator?.overhead?.persona, 900), 0, 8000),
        format: clamp(num(budgetCfg.narrator?.overhead?.format, 400), 0, 8000),
      },
      sections: budgetCfg.narrator?.sections ?? {},
      trimOrder: budgetCfg.narrator?.trimOrder ?? [],
      pinned: budgetCfg.narrator?.pinned ?? ['rules', 'action'],
    },
    archivist: {
      totalInput: clamp(num(budgetCfg.archivist?.totalInput, 3700), 800, 64000),
      sections: budgetCfg.archivist?.sections ?? {},
      sceneTextHeadRatio: clamp(num(budgetCfg.archivist?.sceneTextHeadRatio, 0.4), 0, 1),
    },
    maxOpsPerPatch: clamp(num(budgetCfg.maxOpsPerPatch, 20), 1, 100),
    recentSummaries: clamp(num(budgetCfg.recentSummaries, 8), 1, 40),
    maxCast: clamp(num(budgetCfg.maxCast, 8), 1, 40),
    maxPlaces: clamp(num(budgetCfg.maxPlaces, 4), 0, 20),
    maxRelations: clamp(num(budgetCfg.maxRelations, 10), 0, 40),
    maxClues: clamp(num(budgetCfg.maxClues, 8), 0, 30),
    maxArc: clamp(num(budgetCfg.maxArc, 12), 1, 50),
    maxPlaceEvents: clamp(num(budgetCfg.maxPlaceEvents, 12), 1, 50),
    maxFacts: clamp(num(budgetCfg.maxFacts, 40), 1, 200),
    // 全局未收线索上限：不是"进 prompt 的条数"（那是 maxClues），而是总账
    maxOpenClues: clamp(num(budgetCfg.maxOpenClues, 12), 3, 40),
    promptFacts: clamp(num(budgetCfg.promptFacts, 10), 0, 40),
    promptArcPerCast: clamp(num(budgetCfg.promptArcPerCast, 2), 0, 6),
    promptPlaceEvents: clamp(num(budgetCfg.promptPlaceEvents, 3), 0, 8),
  },

  ratelimit: {
    narrateRpm: clamp(num(rateCfg.narrateRpm, 8), 1, 600),
    structuredRpm: clamp(num(rateCfg.structuredRpm, 20), 1, 600),
    maxConcurrency: clamp(num(rateCfg.maxConcurrency, 2), 1, 16),
  },

  features: {
    tts: featureCfg.tts === true,
    image: featureCfg.image === true,
    dream: featureCfg.dream === true,
    economy: featureCfg.economy === true,
  },

  recall: {
    enabled: recallCfg.enabled !== false,
    mode: recallCfg.mode === 'vector' ? 'vector' : 'keyword',
    topK: clamp(num(recallCfg.topK, 6), 1, 20),
    keep: clamp(num(recallCfg.keep, 4), 1, 10),
    minScore: clamp(num(recallCfg.minScore, 0.32), 0, 1),
    weights: {
      cosine: num(recallCfg.weights?.cosine, 0.7),
      recency: num(recallCfg.weights?.recency, 0.2),
      entity: num(recallCfg.weights?.entity, 0.1),
    },
    waitMs: clamp(num(recallCfg.waitMs, 1500), 0, 10000),
    chunk: {
      maxChars: clamp(num(recallCfg.chunk?.maxChars, 600), 200, 2000),
      overlapChars: clamp(num(recallCfg.chunk?.overlapChars, 60), 0, 300),
    },
    embedding: {
      source: recallCfg.embedding?.source ?? 'hf',
      model: recallCfg.embedding?.model ?? 'Xenova/bge-small-zh-v1.5',
      modelScopeId: recallCfg.embedding?.modelScopeId ?? 'BAAI/bge-small-zh-v1.5',
      dim: clamp(num(recallCfg.embedding?.dim, 512), 64, 4096),
      device: recallCfg.embedding?.device ?? 'wasm',
    },
  },

  eval: evalCfg,
}

/** 内容预算 = 总输入 - 服务端模板开销 */
export function contentBudget() {
  const n = config.budget.narrator
  return Math.max(400, n.totalInput - n.overhead.persona - n.overhead.format)
}

/** 下发给前端的配置：不含任何密钥。 */
export function getPublicConfig() {
  return {
    appName: config.appName,
    model: MOCK ? 'mock' : config.llm.model || '(未配置)',
    presets: config.narrative.presets,
    defaultPreset: config.narrative.defaultPreset,
    choiceCount: config.narrative.choiceCount,
    temperature: config.llm.temperature.narrator,
    features: config.features,
    limits: {
      narrateRpm: config.ratelimit.narrateRpm,
      structuredRpm: config.ratelimit.structuredRpm,
      maxConcurrency: config.ratelimit.maxConcurrency,
      maxOutputChars: config.llm.maxOutputChars.narrator,
    },
    budget: {
      contentBudget: contentBudget(),
      sections: config.budget.narrator.sections,
      overhead: config.budget.narrator.overhead,
      trimOrder: config.budget.narrator.trimOrder,
      pinned: config.budget.narrator.pinned,
      maxCast: config.budget.maxCast,
      maxPlaces: config.budget.maxPlaces,
      maxRelations: config.budget.maxRelations,
      maxClues: config.budget.maxClues,
      recentSummaries: config.budget.recentSummaries,
      maxArc: config.budget.maxArc,
      maxPlaceEvents: config.budget.maxPlaceEvents,
      maxFacts: config.budget.maxFacts,
      maxOpenClues: config.budget.maxOpenClues,
      promptFacts: config.budget.promptFacts,
    },
    recall: {
      enabled: config.recall.enabled,
      mode: config.recall.mode,
      topK: config.recall.topK,
      keep: config.recall.keep,
      minScore: config.recall.minScore,
      embedding: {
        source: config.recall.embedding.source,
        model: config.recall.embedding.model,
        dim: config.recall.embedding.dim,
        device: config.recall.embedding.device,
      },
    },
    hasServerKey: Boolean(config.llm.apiKey) || MOCK,
    mock: MOCK,
  }
}
