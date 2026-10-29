/**
 * 假数据回放：`LLM_MOCK=1` 时不调上游、不烧额度、不需要 Key。
 *
 * 它的价值不是"演示"，而是让 UI 开发与集成测试不被真实网络的抖动拖慢，
 * 并且能稳定复现「坏 JSON → 修复」这条最容易崩的路径。
 */

const OPENINGS = [
  '门轴发出一声很轻的响，像有人在里面扶着。',
  '脚步在石板上停了一下，雾从巷口漫过来。',
  '灯芯爆了一声，屋子里的影子齐齐晃了晃。',
  '风把窗纸吹得鼓起来，又慢慢瘪回去。',
]

const MIDDLES = [
  '柜台后面的人没有抬头，只把茶碗往前推了半寸。',
  '墙角堆着几只没拆的箱子，最上面那只落了厚厚一层灰。',
  '有人在外间咳嗽了两声，随即又安静下去。',
  '桌面上摊着一张旧报纸，日期被水泡得看不清。',
]

const CLOSINGS = [
  '「你迟到了。」那个声音比记忆里低一些。',
  '「东西带来了吗？」问话的人始终没转身。',
  '「这里不是说话的地方。」对方把门掩上了一半。',
  '没有人回答，只有远处汽笛响了两声，又停了。',
]

/** 由 action 与前情长度推一个稳定的索引：同一个 action 不会每次给出同一段。 */
function seedOf(req) {
  const text = `${String(req?.sections?.action ?? '')}|${String(
    req?.sections?.summaries ?? '',
  ).length}|${String(req?.sections?.lastTail ?? '').length}`
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const CHOICE_POOL = [
  '顺着话头问下去',
  '先不接话，看看屋里还有什么',
  '转身离开，记住这个人的脸',
  '把茶碗推回去，等对方先开口',
  '直接问他东西的下落',
  '假装没听懂，反问一句',
]

export function mockNarration(req) {
  const seed = seedOf(req)
  const action = String(req?.sections?.action ?? '').trim()
  // 已有幕数：保证相邻两幕至少在开场句上不同（只靠 hash 取模会撞车）
  const turn = (String(req?.sections?.summaries ?? '').match(/第\s*\d+\s*幕/g) ?? []).length
  const opening = OPENINGS[turn % OPENINGS.length]
  const middle = MIDDLES[(turn + seed) % MIDDLES.length]
  const closing = CLOSINGS[(turn * 2 + (seed >>> 6)) % CLOSINGS.length]
  const body = action
    ? `他想起刚才的决定——${action.slice(0, 24)}——${opening}${middle}${closing}`
    : `${opening}${middle}${closing}`

  const count = Math.min(3, Math.max(1, Number(req?.choiceCount) || 3))
  const start = (seed >>> 9) % CHOICE_POOL.length
  const choices = Array.from({ length: count }, (_, i) => CHOICE_POOL[(start + i) % CHOICE_POOL.length])
  return [
    '<scene>',
    body,
    '</scene>',
    '<choices>',
    ...choices.map((c, i) => `${i + 1}. ${c}`),
    '</choices>',
  ].join('\n')
}

/** 把文本切成小块，模拟真实流式节奏。 */
export async function* mockNarrateStream(req, opts = {}) {
  const full = mockNarration(req)
  const size = opts.chunkSize ?? 14
  for (let i = 0; i < full.length; i += size) {
    await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 15))
    yield { content: full.slice(i, i + size) }
  }
  yield { usage: { prompt_tokens: 1200, completion_tokens: Math.ceil(full.length / 2), total_tokens: 1800 } }
  yield { finishReason: 'stop' }
}

/** 产出的 evidence 一律取自正文，保证能过子串校验。 */
export function mockArchive(sceneText, opts = {}) {
  if (opts.bad) {
    // 故意坏掉的 JSON：缺右括号 + 尾逗号 + 中文引号
    return `{"summary":"（这是个坏样例）","ops":[{"op":"append-clue","kind":"fact","text":"坏样例","evidence":"${String(
      sceneText ?? '',
    ).slice(0, 6)}"}，“warnings":[]`
  }

  const evidence = String(sceneText ?? '').replace(/\s/g, '').slice(0, 8) || '正文'
  return JSON.stringify({
    summary: '他推门进去，屋里有人先开了口，雾跟着涌进来。',
    ops: [
      {
        op: 'upsert-cast',
        ref: '掌柜',
        evidence,
        confidence: 0.8,
        value: { oneLine: '柜台后面的人，话很少', voice: '低而慢' },
      },
      {
        op: 'append-place-event',
        ref: '同福客栈',
        text: '有人在这里等他',
        evidence,
      },
      {
        op: 'append-clue',
        kind: 'open-thread',
        text: '他说「你迟到了」，像是早就知道他会来',
        evidence,
      },
      {
        op: 'assert-fact',
        subject: '汽笛',
        predicate: '响过',
        object: '两声',
        kind: 'number',
        evidence,
      },
    ],
    warnings: [],
  })
}

export async function mockArchiveResponse(req, opts = {}) {
  await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 60))
  return {
    text: mockArchive(req?.sceneText, opts),
    usage: { prompt_tokens: 900, completion_tokens: 220, total_tokens: 1120 },
  }
}

/** 演示模式的空间设定样例：结构与真实输出一致，供前端校验路径跑通。 */
export const MOCK_SEED = JSON.stringify({
  world: {
    name: '雾港',
    era: '民国十七年',
    theme: '真相值不值得',
    premise: '一座靠走私活着的港口，所有旧账都在雾里',
    oneLine: '雾里的港口，旧账未清',
    rules: ['天黑后不出海的人，才有资格上岸', '缉私队收钱，但从不收两次'],
    factions: ['缉私队', '潮帮'],
  },
  cast: [
    {
      name: '林昭',
      role: 'protagonist',
      oneLine: '从北方回来的报馆记者',
      voice: '语速慢，问句多',
      traits: ['固执', '记性好'],
      goal: '查清父亲那年冬天是怎么死的',
    },
    {
      name: '阿棠',
      role: 'support',
      oneLine: '客栈里什么都听的姑娘',
      voice: '直白',
      traits: ['机灵'],
      goal: '攒够钱离开雾港',
    },
    {
      name: '掌柜',
      role: 'antagonist',
      oneLine: '同福客栈的老板，什么都记得',
      voice: '寡言',
      traits: ['谨慎'],
      goal: '保住客栈，也保住那年的秘密',
    },
  ],
  places: [
    { name: '同福客栈', kind: '客栈', oneLine: '雾港唯一还亮着灯的客栈', features: ['柜台', '后厨的井'] },
    { name: '三号仓库', kind: '仓库', oneLine: '堆着没人认领的油布', features: ['侧门小屋'] },
  ],
  opening: '雾漫上码头的那个傍晚，林昭拎着一只藤条箱下了船。',
})
