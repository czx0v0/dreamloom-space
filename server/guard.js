/**
 * 限流与熔断。
 *
 * 服务端持有密钥 = 开放代理，这一点无法在架构上消除，只能设上限：
 *  - 令牌桶按 IP 限速（防脚本刷）
 *  - 全局并发上限（个人 key 的 TPM 撑不住更多）
 *  - 每日字符熔断（最后一道，超额当天直接拒绝）
 *
 * 全内存实现，重启归零——个人应用的合理取舍。
 */

export function createGuard(cfg) {
  const buckets = new Map()
  let active = 0
  let usedChars = 0
  let dayKey = todayKey()

  function todayKey() {
    return new Date().toISOString().slice(0, 10)
  }

  function rollDay() {
    const now = todayKey()
    if (now !== dayKey) {
      dayKey = now
      usedChars = 0
    }
  }

  function take(route, ip) {
    rollDay()
    const rpm = route === 'narrate' ? cfg.narrateRpm : cfg.structuredRpm
    const key = `${route}:${ip || 'unknown'}`
    const now = Date.now()
    const bucket = buckets.get(key) ?? { tokens: rpm, updated: now }
    const elapsed = now - bucket.updated
    bucket.tokens = Math.min(rpm, bucket.tokens + (elapsed * rpm) / 60000)
    bucket.updated = now

    if (bucket.tokens < 1) {
      buckets.set(key, bucket)
      const needMs = Math.ceil(((1 - bucket.tokens) / rpm) * 60000)
      return { ok: false, code: 'E_RATE_LIMITED', retryAfterMs: needMs }
    }
    bucket.tokens -= 1
    buckets.set(key, bucket)
    return { ok: true }
  }

  function quotaExceeded() {
    rollDay()
    return usedChars >= cfg.dailyCharBudget
  }

  function acquire() {
    if (active >= cfg.maxConcurrency) return false
    active += 1
    return true
  }

  function release() {
    active = Math.max(0, active - 1)
  }

  function charge(chars) {
    rollDay()
    usedChars += Math.max(0, Math.floor(chars))
  }

  function status() {
    rollDay()
    return { active, usedChars, dailyBudget: cfg.dailyCharBudget, day: dayKey }
  }

  function reset() {
    buckets.clear()
    active = 0
    usedChars = 0
  }

  return { take, acquire, release, charge, status, quotaExceeded, reset }
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim()
  return req.socket?.remoteAddress ?? 'unknown'
}
