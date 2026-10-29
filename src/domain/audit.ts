/**
 * 出文后审计：在落库之前拦一次明显违规。
 * 只做高置信度判定 —— 误报会让玩家频繁看到无意义的提示，比漏报更伤。
 */

export interface AuditIssue {
  severity: 'block' | 'warn'
  code: string
  message: string
}

export interface AuditContext {
  deadNames: string[]
  knownNames: string[]
  actionVerbs: string[]
  target: { min: number; max: number }
}

const MEMORY_WORDS = ['回忆', '生前', '曾经', '梦里', '梦中', '记忆', '想起', '照片', '墓碑', '遗物', '幻觉', '若是', '假如']
const NAME_STOPWORDS = new Set([
  '众人', '有人', '有人', '那人', '老人', '声音', '旁边', '他们', '我们', '大家', '对方',
  '身后', '远处', '所有人', '一个人', '两个人', '门外', '楼上', '身后', '空气中',
])
const SPEAK_PATTERN = /([\u4e00-\u9fa5]{2,4})(?=(?:说道|问道|答道|喊道|笑道|说|道|问|答|喊|笑|叫|嘀咕|低语))/g

function windowAround(text: string, index: number, nameLen: number, span = 40): string {
  return text.slice(Math.max(0, index - span), Math.min(text.length, index + nameLen + span))
}

export function auditScene(text: string, ctx: AuditContext): AuditIssue[] {
  const issues: AuditIssue[] = []
  const body = text ?? ''

  // 1) 已死亡角色是否有行动/说话
  for (const name of ctx.deadNames) {
    if (!name) continue
    let from = 0
    let blocked = false
    let warned = false
    while (true) {
      const idx = body.indexOf(name, from)
      if (idx < 0) break
      from = idx + name.length
      const win = windowAround(body, idx, name.length)
      if (MEMORY_WORDS.some((w) => win.includes(w))) {
        warned = true
        continue
      }
      if (ctx.actionVerbs.some((v) => win.includes(v))) {
        blocked = true
        break
      }
    }
    if (blocked) {
      issues.push({
        severity: 'block',
        code: 'DEAD_ACTING',
        message: `「${name}」已经死亡，但这一段里让它行动了`,
      })
    } else if (warned) {
      issues.push({
        severity: 'warn',
        code: 'DEAD_IN_MEMORY',
        message: `「${name}」以回忆形式出现（已死亡）`,
      })
    }
  }

  // 2) 疑似新出现的人名（只提示，不拦截）
  const known = new Set(ctx.knownNames)
  const dead = new Set(ctx.deadNames)
  const unknown = new Set<string>()
  for (const m of body.matchAll(SPEAK_PATTERN)) {
    const candidate = m[1]
    if (!candidate || candidate.length < 2) continue
    if (NAME_STOPWORDS.has(candidate)) continue
    if (known.has(candidate) || dead.has(candidate)) continue
    if (Array.from(known).some((k) => k.includes(candidate) || candidate.includes(k))) continue
    unknown.add(candidate)
  }
  if (unknown.size > 0) {
    issues.push({
      severity: 'warn',
      code: 'UNKNOWN_NAME',
      message: `出现档案里没有的名字：${Array.from(unknown).slice(0, 3).join('、')}`,
    })
  }

  // 3) 字数偏差
  const chars = body.replace(/\s/g, '').length
  const { min, max } = ctx.target
  if (chars < Math.floor(min * 0.75)) {
    issues.push({
      severity: 'warn',
      code: 'TOO_SHORT',
      message: `这一段只有 ${chars} 字，比目标（${min}–${max}）短了不少`,
    })
  } else if (chars > Math.ceil(max * 1.25)) {
    issues.push({
      severity: 'warn',
      code: 'TOO_LONG',
      message: `这一段有 ${chars} 字，超出目标（${min}–${max}）较多`,
    })
  }

  return issues
}

export function hasBlockingIssue(issues: AuditIssue[]): boolean {
  return issues.some((i) => i.severity === 'block')
}
