#!/usr/bin/env node
/**
 * 把本机的 `.env.local` 同步成部署用的 `deploy/app/secrets.json`。
 *
 * 为什么要有这一步：线上实例要给「打开就能用」的体验，就得带一把站点 Key；
 * 而这把 Key 只能放在服务端（前端拿不到），并且不能进 git。
 * 手动复制容易漏项、也容易把 Key 贴进聊天/提交里，所以交给脚本读、脚本写。
 *
 * 用法：
 *   node scripts/sync-secrets.mjs            # 从 .env.local 读，写 deploy/app/secrets.json
 *   node scripts/sync-secrets.mjs --dry-run  # 只报会写哪些键，不落盘
 *
 * 输出只列变量名与长度，不打印值。
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'deploy', 'app', 'secrets.json')
const dryRun = process.argv.includes('--dry-run')

/** 允许带过去的键：只挑部署需要的，别把本地调试项一起搬过去 */
const PICK = [
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_API_KEY',
  'IMAGE_BASE_URL',
  'IMAGE_MODEL',
  'IMAGE_API_KEY',
  'TTS_BASE_URL',
  'TTS_MODEL',
  'TTS_API_KEY',
  'DAILY_CHAR_BUDGET',
]

function parseEnv(file) {
  const text = readFileSync(file, 'utf8')
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!m) continue
    const value = m[2].replace(/^['"]|['"]$/g, '').trim()
    if (value) out[m[1]] = value
  }
  return out
}

const source = ['.env.local', '.env'].map((f) => join(ROOT, f)).find((f) => existsSync(f))
if (!source) {
  console.error('没有找到 .env.local 或 .env。先参照 .env.example 建一份。')
  process.exit(1)
}

const env = parseEnv(source)
const picked = {}
for (const key of PICK) {
  // 空值不写：留空代表"沿用文本配置"，写进去反而会覆盖掉默认回落逻辑
  if (env[key]) picked[key] = env[key]
}

if (!picked.LLM_API_KEY) {
  console.error('源文件里没有 LLM_API_KEY，拒绝生成（线上会变成"没有 Key"）。')
  process.exit(1)
}

const report = Object.entries(picked).map(([k, v]) => `${k}（${String(v).length} 字符）`)
console.log(`来源：${source === join(ROOT, '.env.local') ? '.env.local' : '.env'}`)
console.log('将写入：\n  - ' + report.join('\n  - '))

if (!dryRun) {
  // 数字型的额度转成字符串：secrets.json 只接受字符串/数字，统一成字符串最省事
  const payload = {
    _comment: '站点 Key：只放服务端，勿提交。用 node scripts/sync-secrets.mjs 生成。',
    ...picked,
  }
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  try {
    chmodSync(OUT, 0o600)
  } catch {
    /* Windows 上可能不支持，忽略 */
  }
  console.log(`\n已写入 ${OUT}`)
  console.log('下一步：重新发布，线上就带这把 Key 了。')
} else {
  console.log('\n（dry-run，没有写文件）')
}
