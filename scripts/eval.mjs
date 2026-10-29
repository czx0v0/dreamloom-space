#!/usr/bin/env node
/**
 * 客观评测：把 20 例真实翻车场景跑一遍档案员，算四个可判定的指标。
 *
 * 为什么是脚本而不是单测：它要真实模型、要花钱、结果有方差。
 * 放进 CI 会让"测试通过但体验变差"变成常态；留在这里，改 prompt 前手动跑。
 *
 *   npm run dev:api          # 另开一个终端
 *   npm run eval             # 本脚本
 *   EVAL_BASE=http://localhost:3000 npm run eval
 *
 * 退出码：门禁不通过为 1，便于 shell 里 `&&` 串起来。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CASES_DIR = join(ROOT, 'tests', 'fixtures', 'eval')
const BASE = process.env.EVAL_BASE || 'http://localhost:3000'

const THRESHOLDS = {
  evidence: 0.95,
  schema: 0.98,
  hallucination: 0.05,
  revival: 0,
}

/** 只做评测需要的归一化，不追求与 `domain/alias.ts` 完全一致（那边有单测）。 */
function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

function parseJson(raw) {
  const text = String(raw ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

async function loadCases() {
  const files = (await readdir(CASES_DIR)).filter((f) => f.endsWith('.json')).sort()
  const cases = []
  for (const file of files) {
    cases.push(JSON.parse(await readFile(join(CASES_DIR, file), 'utf8')))
  }
  return cases
}

async function archive(c, key) {
  const res = await fetch(`${BASE}/api/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-llm-key': key } : {}) },
    body: JSON.stringify({
      runId: `eval_${c.id}`,
      sceneId: 'sc_eval',
      sceneText: c.sceneText,
      canon: c.canon ?? { cast: [], places: [], relations: [] },
    }),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

function score(c, raw) {
  const data = parseJson(raw)
  if (!data || !Array.isArray(data.ops)) {
    return { schema: false, ops: 0, evidenceOk: 0, evidenceTotal: 0, halluc: 0, refs: 0, revival: 0 }
  }
  const scene = norm(c.sceneText)
  const knownNames = new Set((c.canon?.cast ?? []).map((x) => norm(x.name)))
  const deadNames = new Set(
    (c.canon?.cast ?? []).filter((x) => x.status === 'dead').map((x) => norm(x.name)),
  )

  let evidenceOk = 0
  let evidenceTotal = 0
  let halluc = 0
  let refs = 0
  let revival = 0

  for (const op of data.ops) {
    if (op.evidence) {
      evidenceTotal++
      const needle = norm(op.evidence)
      // 省略号与截断：只要求前半段能在正文里找到
      const probe = needle.slice(0, Math.max(6, Math.min(needle.length, 12)))
      if (probe && scene.includes(probe)) evidenceOk++
    }

    // 只对「实体引用」统计幻觉。事实的 subject/object 是短语（"提货单""四箱"），
    // 收线的 ref 是编号（"#3"），把它们算进来只会让指标失真。
    const ENTITY_OPS = new Set([
      'upsert-cast',
      'upsert-place',
      'upsert-relation',
      'move-to',
      'append-arc',
      'reveal-hidden',
      'tombstone',
    ])
    if (!ENTITY_OPS.has(op.op)) continue
    const refsOfOp = (
      op.op === 'upsert-relation' ? [op.a, op.b] : [op.ref]
    ).filter((x) => typeof x === 'string' && x)
    for (const ref of refsOfOp) {
      refs++
      const n = norm(ref)
      if (!n || scene.includes(n)) continue
      // 只统计"凭空造出来的新实体"：正文没提过、档案里也没有，却给它建了条目。
      // 已有实体在正文里以"他/她"出现是正常写法，不能算幻觉——早前按"名字没出现"
      // 统计，纯对白那类用例会被冤枉（见 case-018）。
      if (!knownNames.has(n)) halluc++
    }

    if (op.op === 'upsert-cast' && op.value?.status === 'alive' && deadNames.has(norm(op.ref))) {
      revival++
    }
  }

  return {
    schema: true,
    ops: data.ops.length,
    evidenceOk,
    evidenceTotal,
    halluc,
    refs,
    revival,
  }
}

function pct(n, d) {
  if (!d) return 1
  return n / d
}

async function main() {
  const key = process.env.LLM_API_KEY || ''
  const cases = await loadCases()
  if (!cases.length) {
    console.error('没有找到用例：tests/fixtures/eval/*.json')
    process.exit(1)
  }

  const rows = []
  let schemaOk = 0
  let evOk = 0
  let evTotal = 0
  let halluc = 0
  let refs = 0
  let revival = 0

  for (const c of cases) {
    const started = Date.now()
    let row
    try {
      const res = await archive(c, key)
      const s = score(c, res.text)
      row = { id: c.id, ...s, ms: Date.now() - started }
    } catch (e) {
      row = {
        id: c.id,
        schema: false,
        ops: 0,
        evidenceOk: 0,
        evidenceTotal: 0,
        halluc: 0,
        refs: 0,
        revival: 0,
        ms: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
      }
    }
    rows.push(row)
    if (row.schema) schemaOk++
    evOk += row.evidenceOk
    evTotal += row.evidenceTotal
    halluc += row.halluc
    refs += row.refs
    revival += row.revival
    process.stdout.write(row.schema ? '.' : 'x')
  }
  process.stdout.write('\n\n')

  const summary = {
    evidence: pct(evOk, evTotal),
    schema: pct(schemaOk, cases.length),
    hallucination: pct(halluc, refs),
    revival,
  }

  console.log('用例\t\t证据忠实度\tschema\top\t延迟')
  for (const r of rows) {
    const ev = pct(r.evidenceOk, r.evidenceTotal).toFixed(2)
    console.log(
      `${r.id}\t${ev}\t\t${r.schema ? 'ok' : 'FAIL'}\t${r.ops}\t${(r.ms / 1000).toFixed(1)}s${
        r.error ? `\t${r.error.slice(0, 60)}` : ''
      }`,
    )
  }

  console.log(
    `\n汇总\t证据 ${summary.evidence.toFixed(2)}\tschema ${summary.schema.toFixed(2)}` +
      `\t幻觉 ${summary.hallucination.toFixed(2)}\t复活 ${summary.revival}`,
  )

  const pass =
    summary.evidence >= THRESHOLDS.evidence &&
    summary.schema >= THRESHOLDS.schema &&
    summary.hallucination <= THRESHOLDS.hallucination &&
    summary.revival <= THRESHOLDS.revival

  console.log(
    `门禁: ${pass ? 'PASS' : 'FAIL'}` +
      `（evidence≥${THRESHOLDS.evidence}, schema≥${THRESHOLDS.schema}, 幻觉≤${THRESHOLDS.hallucination}, 复活=${THRESHOLDS.revival}）`,
  )
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('评测失败：', e instanceof Error ? e.message : e)
  console.error('如果连接不上，先在另一个终端跑 `npm run dev:api`。')
  process.exit(1)
})
