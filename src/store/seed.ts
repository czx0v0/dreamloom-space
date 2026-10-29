/**
 * 内置模板：让「新建空间」不必从空白开始。
 * 每个模板只带最小可运行量——一个世界、三张人物卡、两个地点。
 */

import type { CastRole, World } from '../domain/types'

export interface SeedCast {
  name: string
  role?: CastRole
  oneLine?: string
  voice?: string
  traits?: string[]
  secrets?: string[]
}

export interface SeedPlace {
  name: string
  kind?: string
  oneLine?: string
  features?: string[]
}

export interface SeedTemplate {
  id: string
  name: string
  tagline: string
  genre: string
  tone: string
  cover: string
  world: World
  cast: SeedCast[]
  places: SeedPlace[]
}

const now = 0

export const TEMPLATES: SeedTemplate[] = [
  {
    id: 'tpl_fog_port',
    name: '雾港旧案',
    tagline: '一桩十年前的案子，把所有人重新钉回同一张桌上',
    genre: '悬疑',
    tone: '冷峻',
    cover: '🌫️',
    world: {
      name: '雾港',
      era: '民国十七年',
      theme: '真相到底值不值得',
      premise: '港口终年多雾，雾里有人撒谎，也有人靠雾活着',
      oneLine: '一座靠走私活着的港口城市',
      rules: ['雾港没有正式的警察，只有码头的规矩', '雾一起，船上的人说什么都不作数'],
      factions: ['码头帮', '海关', '报馆'],
      updatedAt: now,
    },
    cast: [
      {
        name: '林昭',
        role: 'protagonist',
        oneLine: '从北方回来的报馆记者',
        voice: '语速很慢，习惯先问一句再答',
        traits: ['冷静', '固执', '记性极好'],
        secrets: ['他回来不是为了查案，是为了找一个人'],
      },
      {
        name: '掌柜',
        role: 'support',
        oneLine: '同福客栈的老板，什么都记得',
        voice: '慢条斯理，爱用反问',
        traits: ['谨慎', '贪财'],
      },
      {
        name: '阿棠',
        role: 'support',
        oneLine: '码头上跑腿的姑娘，认得所有船',
        voice: '快，带一点码头腔',
        traits: ['机灵', '嘴硬'],
        secrets: ['她替码头帮送过一封不该送的信'],
      },
    ],
    places: [
      { name: '同福客栈', kind: '客栈', oneLine: '临街两层，后厨有口老井', features: ['后厨', '二层走廊'] },
      { name: '三号仓库', kind: '仓库', oneLine: '码头尽头，夜里不上锁' },
    ],
  },
  {
    id: 'tpl_long_night',
    name: '长夜书院',
    tagline: '书院每七年烧一次，每次烧掉的都是同一个人',
    genre: '奇幻',
    tone: '幽微',
    cover: '🕯️',
    world: {
      name: '长夜书院',
      era: '不知年',
      theme: '记忆是不是一个人的全部',
      premise: '书院在山里，山外的天永远是夜',
      oneLine: '一座不收学费、只收记忆的书院',
      rules: ['书院里不能提"外面"两个字', '每七年冬至，藏书楼必起火'],
      factions: ['山长', '抄书生', '守夜人'],
      updatedAt: now,
    },
    cast: [
      {
        name: '沈砚',
        role: 'protagonist',
        oneLine: '新来的抄书生，写一手好字',
        voice: '说话很轻，像怕惊到谁',
        traits: ['安静', '过目不忘'],
        secrets: ['他其实是来还一本书的'],
      },
      {
        name: '山长',
        role: 'antagonist',
        oneLine: '书院的主人，从不走出藏书楼',
        voice: '温和，但每句话都像结论',
        traits: ['博学', '不容置疑'],
      },
      {
        name: '阿萤',
        role: 'support',
        oneLine: '守夜人的女儿，能看见火',
        voice: '直接，不绕弯',
        traits: ['敏锐', '怕黑'],
      },
    ],
    places: [
      { name: '藏书楼', kind: '楼阁', oneLine: '七层，越往上越冷' },
      { name: '抄书堂', kind: '书斋', oneLine: '三十张桌子，只有一张有灯' },
    ],
  },
  {
    id: 'tpl_tide_farm',
    name: '潮汐农场',
    tagline: '海退之后，地里长出来的东西不太对',
    genre: '日常·微恐',
    tone: '温柔',
    cover: '🌾',
    world: {
      name: '潮汐农场',
      era: '近未来',
      theme: '我们能不能接受不是自己的孩子',
      premise: '海水退去后留下的滩涂，被改成了农田',
      oneLine: '一个靠退潮耕作的农场',
      rules: ['涨潮时不能下地', '地里长出来的东西不能带进屋'],
      factions: ['农场主', '收购站'],
      updatedAt: now,
    },
    cast: [
      {
        name: '陈屿',
        role: 'protagonist',
        oneLine: '接手农场第三年，还没习惯潮声',
        voice: '温和，话少',
        traits: ['耐心', '认死理'],
      },
      {
        name: '小满',
        role: 'support',
        oneLine: '邻居家的孩子，总在田埂上等退潮',
        voice: '清脆，爱问为什么',
        traits: ['好奇', '不怕脏'],
        secrets: ['她记得上一次涨潮时发生的事'],
      },
    ],
    places: [
      { name: '主屋', kind: '农舍', oneLine: '三间房，屋顶漏雨' },
      { name: '滩涂田', kind: '田地', oneLine: '退潮后能走进去，泥很软' },
    ],
  },
]

export function findTemplate(id: string): SeedTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id)
}

/** 随机起点：从模板里随机取一个，并给标题加一点变化。 */
export function pickTemplate(rand: () => number = Math.random): SeedTemplate {
  return TEMPLATES[Math.floor(rand() * TEMPLATES.length) % TEMPLATES.length]
}
