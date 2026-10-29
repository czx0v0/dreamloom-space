/** id 生成：前缀 + 时间序 base32，保证同一毫秒内也不冲突。 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

export type Clock = () => number

/**
 * 同一毫秒内递增的计数器。
 *
 * 只靠「时间 + 随机」是不够的：测试里 rand 常常是固定值，真实环境里同一毫秒
 * 连发也可能撞上同一个随机数。一旦 id 重复，写 KV 时后写的会覆盖先写的
 * ——表现为「人物莫名少了一个」，极难排查。所以加一个单调计数器兜底。
 */
let sequence = 0

export function makeId(prefix: string, now: number, rand: () => number = Math.random): string {
  sequence = (sequence + 1) % 1024

  let n = Math.floor(now)
  let time = ''
  for (let i = 0; i < 8; i++) {
    time = ALPHABET[n % 32] + time
    n = Math.floor(n / 32)
  }

  // 2 位序号（1024 个/毫秒）+ 3 位随机：同毫秒内几乎不可能再撞
  const seq = ALPHABET[Math.floor(sequence / 32) % 32] + ALPHABET[sequence % 32]
  let tail = ''
  for (let i = 0; i < 3; i++) {
    tail += ALPHABET[Math.floor(rand() * 32) % 32]
  }
  return `${prefix}_${time}${seq}${tail}`
}

/** 仅供测试使用：重置序号，避免跨用例互相影响。 */
export function resetIdSequence(): void {
  sequence = 0
}

export const ID = {
  space: 'sp',
  world: 'wd',
  cast: 'ch',
  place: 'pl',
  relation: 'rl',
  scene: 'sc',
  patch: 'pt',
} as const

export function newSpaceId(now: number, rand?: () => number): string {
  return makeId(ID.space, now, rand)
}
