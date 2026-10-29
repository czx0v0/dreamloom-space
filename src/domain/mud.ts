/**
 * 入梦（最小版）：文字 MUD 的动词解析。
 *
 * 只做四件事：看、走、说、用。不做物品栏、不做地图坐标——
 * 那两样一旦建表就要同步，而这一版的目标是"能在故事里走两步"。
 *
 * 解析必须宽容：玩家会写"我推门进去看看"这种复合句。取第一个命中的动词，
 * 剩下的整句当目标，宁可理解得粗一点，也不要回一句"命令无法识别"。
 */

export type MudVerb = 'look' | 'go' | 'say' | 'use' | 'unknown'

export interface MudCommand {
  verb: MudVerb
  /** 动词之后的部分（地点 / 人 / 物件 / 话），可能为空 */
  target: string
  /** 原始输入，用于提示与日志 */
  raw: string
}

const VERBS: Array<{ verb: MudVerb; words: string[] }> = [
  { verb: 'look', words: ['看看', '看', '观察', '打量', '环顾', '瞧', '检查', '听听', '听'] },
  { verb: 'go', words: ['走到', '走向', '去', '进', '回', '出', '离开', '前往', '上楼', '下楼', '过去'] },
  { verb: 'say', words: ['说', '问', '喊', '叫', '告诉', '答', '低声', '开口'] },
  { verb: 'use', words: ['打开', '推开', '放下', '捡起', '拿起', '抓住', '用', '拿', '摸', '翻', '捡', '收', '喝', '吃', '递'] },
]

/** 常见的开头主语：去掉它们，目标才是干净的地点/人名。 */
const LEADING = /^(?:我|你|他|她|再|先|就|便|又|然后|接着)+/

export function parseMudCommand(raw: string): MudCommand {
  const text = (raw ?? '').trim()
  if (!text) return { verb: 'unknown', target: '', raw: text }

  // 逐个动词找最早出现的位置，避免"我推门进去看看"被判成 look
  let best: { verb: MudVerb; at: number; len: number } | null = null
  for (const group of VERBS) {
    for (const word of group.words) {
      const at = text.indexOf(word)
      if (at < 0) continue
      if (!best || at < best.at || (at === best.at && word.length > best.len)) {
        best = { verb: group.verb, at, len: word.length }
      }
    }
  }
  if (!best) return { verb: 'unknown', target: text, raw: text }

  const rest = text.slice(best.at + best.len).replace(LEADING, '').trim()
  return { verb: best.verb, target: rest.replace(/^[，,。.\s]+/, ''), raw: text }
}

/** 给模型的行动描述：把"看/走/说/用"翻译成一句人话。 */
export function describeCommand(cmd: MudCommand, placeName: string): string {
  const at = placeName ? `在「${placeName}」` : '在这片地方'
  switch (cmd.verb) {
    case 'look':
      return `${at}${cmd.target ? `仔细观察「${cmd.target}」` : '环顾四周'}`
    case 'go':
      return cmd.target ? `走向「${cmd.target}」` : '往外面走'
    case 'say':
      return `${cmd.target ? `开口说：${cmd.target}` : '开口说话'}`
    case 'use':
      return cmd.target ? `动手摆弄「${cmd.target}」` : '伸手试着做点什么'
    default:
      return `想做什么说不清楚，只含糊地试了一下（原话：${cmd.raw.slice(0, 30)}）`
  }
}

/** 无法识别时给玩家的提示：列出可用动词，而不是一句"命令错误"。 */
export const MUD_HELP = '能做的只有四件事：看（看某处）、走（去某处）、说（对某人说话）、用（用手上的东西）。'
