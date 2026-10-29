/**
 * 实测验证（live playtest）：真服务端 + 真模型，自动跑完若干空间。
 *
 * 为什么放在 tests/ 而不是 scripts/：只有这里能直接 import 应用的 TS 编排层
 * （`advanceScene` / `pack` / `repo`），复刻一份 JS 版本必然与产品逻辑分叉。
 *
 * 运行：
 *   PLAYTEST=1 npx vitest run tests/live --testTimeout=2400000
 * 需要服务端已在 http://localhost:3000 跑着（npm run dev:api），并配好 LLM key。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { advanceScene } from '../../src/app/advanceScene'
import { fetchConfig } from '../../src/app/config'
import { createSpaceFromSeed } from '../../src/app/createSpace'
import { createArchivist } from '../../src/agents/archivist'
import { createNarrator } from '../../src/agents/narrator'
import { createTriage } from '../../src/agents/triage'
import { DomainError, ERR } from '../../src/domain/errors'
import { resolvePhase } from '../../src/domain/objective'
import { textSimilarity } from '../../src/domain/text'
import type { Scene } from '../../src/domain/types'
import { createMemoryKv } from '../../src/store/kv'
import { createRepo } from '../../src/store/repo'
import { TEMPLATES } from '../../src/store/seed'
import { createPolicy } from './policy'

const BASE = process.env.PLAYTEST_BASE ?? 'http://localhost:3000'
const SCENES_PER_SPACE = Number(process.env.PLAYTEST_SCENES ?? 12)
const SPACE_LIMIT = Number(process.env.PLAYTEST_SPACES ?? 3)
const LIVE = process.env.PLAYTEST === '1'

/** 每个模板给一条主线目标：模板本身只带世界与人物，目标是「有没有终点」的前提。 */
const MAIN_GOALS: Record<string, string> = {
  tpl_fog_port: '查清父亲十年前在雾港的死因，并找到他留下的那封信',
  tpl_long_night: '弄清藏书楼每七年起火一次的原因，并保住自己没被烧掉的那段记忆',
  tpl_tide_farm: '弄清地里长出来的东西到底是什么，以及妻子那晚为什么把它抱进屋',
}

interface Row {
  index: number
  chars: number
  choices: number
  distinctChoices: boolean
  simPrev: number
  ops: number
  archive: string
  openClues: number
  resolved: number
  phase: string
  place: string
  ms: number
  why: string
  action: string
  issues: string[]
}

interface SpaceReport {
  title: string
  mainGoal: string
  rows: Row[]
  scenes: Array<{ index: number; action: string; text: string }>
  failures: string[]
  scheduled: Array<{ at: number; text: string; fired: boolean }>
  cast: string[]
  places: string[]
  /** 诊断：哪些 op 真的落地了、哪些被拒、为什么被拒 */
  opHist: Array<[string, number]>
  skipHist: Array<[string, number]>
  objectives: string[]
  preset: { min: number; max: number }
}

/** 令牌桶只有 8 rpm，主动让路比撞 429 更快。 */
function createPacer(perMinute = 8) {
  const calls: number[] = []
  return async function pace() {
    const now = Date.now()
    while (calls.length && now - calls[0] > 60_000) calls.shift()
    if (calls.length >= perMinute) {
      const wait = 61_000 - (now - calls[0])
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      return pace()
    }
    calls.push(Date.now())
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

describe.skipIf(!LIVE)('live playtest', () => {
  test(
    '跑完 3 个空间并产出报告',
    async () => {
      const config = await fetchConfig(BASE)
      const api = { baseUrl: BASE }
      const narrator = createNarrator(api)
      const archivist = createArchivist(api)
      const triage = createTriage(api)
      const pace = createPacer(8)
      const reports: SpaceReport[] = []

      for (const tpl of TEMPLATES.slice(0, SPACE_LIMIT)) {
        const kv = createMemoryKv()
        const repo = createRepo({ kv, now: () => Date.now() })
        const mainGoal = MAIN_GOALS[tpl.id] ?? `查清${tpl.world.name}那件事的真相`
        const meta = await createSpaceFromSeed({
          repo,
          title: tpl.name,
          genre: tpl.genre,
          tone: tpl.tone,
          cover: tpl.cover,
          world: tpl.world,
          cast: tpl.cast,
          places: tpl.places,
          mainGoal,
          hardRules: tpl.world.rules,
        })

        const policy = createPolicy(20261029 + tpl.id.length)
        const rows: Row[] = []
        const transcript: SpaceReport['scenes'] = []
        const failures: string[] = []
        const opHist = new Map<string, number>()
        const skipHist = new Map<string, number>()
        const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)
        let prevText = ''

        for (let i = 0; i < SCENES_PER_SPACE; i++) {
          const scenes = await repo.listScenes(meta.id)
          const last = scenes[scenes.length - 1]
          const decision =
            i === 0
              ? { kind: 'free' as const, text: '开场', why: 'free' as const }
              : policy.decide({
                  index: i,
                  choices: last?.choices ?? [],
                  mainGoal,
                })

          const started = Date.now()
          let result: Awaited<ReturnType<typeof advanceScene>> | null = null
          for (let attempt = 0; attempt < 3 && !result; attempt++) {
            await pace()
            try {
              result = await advanceScene(
                { repo, narrator, archivist, triage, config, now: () => Date.now(), rand: policy.rand },
                { spaceId: meta.id, action: { kind: decision.kind, text: decision.text } },
              )
            } catch (e) {
              const code = e instanceof DomainError ? e.code : ''
              if (code === ERR.RATE_LIMITED) {
                await sleep(20_000)
                continue
              }
              failures.push(`第 ${i + 1} 幕失败：${e instanceof Error ? e.message : String(e)}`)
              break
            }
          }
          if (!result) break

          const elapsed = Date.now() - started
          const freshMeta = await repo.loadMeta(meta.id)
          const canonNow = await repo.loadCanon(meta.id)
          const patches = await repo.listPatches(meta.id)
          const patch = patches.filter((p) => p.sceneId === result!.scene.id).pop()
          const ci = await repo.listScenes(meta.id)
          // 线索挂在幕上（Scene.clues），不是 CanonState —— 汇总时摊平去重
          const allClues = ci.flatMap((s) => s.clues)
          const openClues = allClues.filter((c) => c.status === 'open').length
          const resolved = allClues.filter((c) => c.status === 'resolved').length
          const placeName = result.scene.placeId
            ? canonNow.places.find((p) => p.id === result.scene.placeId)?.name ?? '（已删地点）'
            : '未定'

          for (const p of patches.filter((x) => x.sceneId === result!.scene.id)) {
            for (const op of p.ops) bump(opHist, op.op)
            for (const r of p.report) {
              if (r.result === 'skipped') bump(skipHist, r.reason ?? 'unknown')
            }
          }

          rows.push({
            index: i + 1,
            chars: result.scene.textChars,
            choices: result.scene.choices.length,
            distinctChoices: isDistinct(result.scene),
            simPrev: prevText ? textSimilarity(prevText, result.text) : 0,
            ops: patch?.ops.length ?? 0,
            archive: result.archiveStatus,
            openClues,
            resolved,
            phase: resolvePhase(freshMeta, ci.length),
            place: placeName,
            ms: elapsed,
            why: decision.why,
            action: decision.text.slice(0, 24),
            issues: result.issues.map((x) => x.code),
          })

          transcript.push({ index: i + 1, action: `${decision.why}：${decision.text}`, text: result.text })
          prevText = result.text
          // 给上游一点喘息：连续 12 幕不留缝会被限流，也会让上游抖动叠加
          await sleep(1200)
        }

        const finalMeta = await repo.loadMeta(meta.id)
        const finalCanon = await repo.loadCanon(meta.id)
        reports.push({
          title: tpl.name,
          mainGoal,
          rows,
          scenes: transcript,
          failures,
          scheduled: finalMeta.scheduled.map((s) => ({ at: s.atSceneIndex, text: s.text, fired: s.fired })),
          cast: finalCanon.cast.map((c) => `${c.name}（${c.status}）`),
          places: finalCanon.places.map((p) => p.name),
          opHist: [...opHist.entries()].sort((a, b) => b[1] - a[1]),
          skipHist: [...skipHist.entries()].sort((a, b) => b[1] - a[1]),
          objectives: finalMeta.objectives.map((o) => `${o.kind}:${o.status}:${o.text.slice(0, 20)}`),
          preset: config.presets[meta.settings.charPreset] ?? { min: 200, max: 320 },
        })
      }

      const reportPath = await writeReport(reports)
      console.log(`\n报告已写入 ${reportPath}\n${summary(reports)}`)

      for (const r of reports) {
        expect(r.failures, `${r.title} 出现失败幕`).toEqual([])
        expect(r.rows.length, `${r.title} 幕数不足`).toBe(SCENES_PER_SPACE)
      }
    },
    2_400_000,
  )
})

function isDistinct(scene: Scene): boolean {
  const labels = scene.choices.map((c) => c.label)
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (textSimilarity(labels[i], labels[j]) > 0.6) return false
    }
  }
  return labels.length >= 2
}

function summary(reports: SpaceReport[]): string {
  const rows = reports.flatMap((r) => r.rows)
  const n = rows.length || 1
  const repeats = rows.filter((r) => r.simPrev > 0.8 && r.index > 1).length
  const distinct = rows.filter((r) => r.distinctChoices).length
  const applied = rows.filter((r) => r.archive === 'applied').length
  const maxClues = Math.max(...rows.map((r) => r.openClues))
  const p95 = rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(n * 0.95) - 1] ?? 0
  const chars = rows.map((r) => r.chars)
  const overshoot = reports.flatMap((r) =>
    r.rows.filter((row) => row.chars > r.preset.max),
  ).length
  const resolvedTotal = reports.reduce((sum, r) => sum + (r.rows[r.rows.length - 1]?.resolved ?? 0), 0)
  const lines = [
    `幕数 ${n} · 平均字数 ${Math.round(chars.reduce((a, b) => a + b, 0) / n)}（${Math.min(...chars)}–${Math.max(...chars)}）`,
    `超出预设上限 ${overshoot} 幕（${((overshoot / n) * 100).toFixed(0)}%）`,
    `重复幕 ${repeats}（≤10% 达标：${((repeats / n) * 100).toFixed(1)}%）`,
    `选项有区分度 ${((distinct / n) * 100).toFixed(0)}%`,
    `抽取成功 ${((applied / n) * 100).toFixed(0)}%`,
    `未收线索峰值 ${maxClues}（上限 12）· 全程收线 ${resolvedTotal} 条`,
    `单幕 p95 ${(p95 / 1000).toFixed(1)}s`,
  ]
  for (const r of reports) {
    const last = r.rows[r.rows.length - 1]
    lines.push(
      `${r.title}: ${r.rows.length} 幕 · ${last?.phase ?? '—'} · 人物 ${r.cast.length} · 地点 ${r.places.length} · 收线 ${last?.resolved ?? 0}`,
    )
  }
  return lines.join('\n')
}

async function writeReport(reports: SpaceReport[]): Promise<string> {
  const dir = join(process.cwd(), 'docs', 'playtests')
  await mkdir(dir, { recursive: true })
  // 文件名用本地时间：用 toISOString 会写成 UTC，报告和日志对不上号
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  const file = join(dir, `${stamp}.md`)
  await writeFile(file, renderReport(reports), 'utf8')
  return file
}

function renderReport(reports: SpaceReport[]): string {
  const out: string[] = [
    `# 实测报告 ${new Date().toLocaleString('zh-CN')}`,
    '',
    `> 自动生成，勿手改。重跑：\`PLAYTEST=1 npx vitest run tests/live --testTimeout=2400000\``,
    '',
    '## 总览',
    '',
    '```',
    summary(reports),
    '```',
    '',
  ]

  for (const r of reports) {
    out.push(`## ${r.title}`, '', `主线目标：${r.mainGoal}`, '')
    out.push(`字数预设 ${r.preset.min}–${r.preset.max}`, '')
    out.push('| 幕 | 行动 | 字数 | 选项 | 区分 | 相似 | op | 抽取 | 未收 | 已收 | 地点 | 阶段 | 耗时 |')
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const row of r.rows) {
      out.push(
        `| ${row.index} | ${row.why}·${row.action} | ${row.chars} | ${row.choices} | ${row.distinctChoices ? '✓' : '✗'} | ${row.simPrev.toFixed(2)} | ${row.ops} | ${row.archive} | ${row.openClues} | ${row.resolved} | ${row.place} | ${row.phase} | ${(row.ms / 1000).toFixed(1)}s |`,
      )
    }
    if (r.failures.length) {
      out.push('', '**失败**', '', ...r.failures.map((f) => `- ${f}`))
    }
    out.push('', '**诊断**', '')
    out.push(`- 落地 op：${r.opHist.map(([k, v]) => `${k}×${v}`).join('、') || '—'}`)
    out.push(`- 被拒原因：${r.skipHist.map(([k, v]) => `${k}×${v}`).join('、') || '—'}`)
    out.push(`- 目标：${r.objectives.join('；') || '—'}`)
    out.push('', `人物：${r.cast.join('、') || '—'}`, '', `地点：${r.places.join('、') || '—'}`, '')
    if (r.scheduled.length) {
      out.push(
        '固定事件：',
        ...r.scheduled.map((s) => `- 第 ${s.at + 1} 幕 ${s.fired ? '已发生' : '未发生'}：${s.text}`),
        '',
      )
    }
    out.push('### 正文', '')
    for (const s of r.scenes) {
      out.push(`#### 第 ${s.index} 幕 · ${s.action}`, '', s.text, '')
    }
  }
  return out.join('\n')
}
