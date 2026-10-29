/**
 * 工具声明（预留）。
 *
 * v1 一律不使用 Function Calling：调用顺序固定，没有"选工具"的空间；
 * 且用户自带的 OpenAI 兼容实现未必支持 tools / strict。
 *
 * 入梦模式才真正需要：NPC 要自己决定查地点、查人物、移动、看背包。
 * 届时把这些声明透传给 `/api/dream`，服务端执行后把结果回灌给模型。
 */

export interface JsonSchemaProp {
  type: 'string' | 'number' | 'boolean'
  description: string
  enum?: string[]
}

export interface ToolSpec {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, JsonSchemaProp>
    required: string[]
  }
}

export const DREAM_TOOLS: ToolSpec[] = [
  {
    name: 'lookup_place',
    description: '按名称查询当前世界中的地点档案，返回简介、特征与货架。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '地点名' } },
      required: ['name'],
    },
  },
  {
    name: 'lookup_character',
    description: '按名称查询人物档案，返回身份、状态、语气与关系。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '人物名' } },
      required: ['name'],
    },
  },
  {
    name: 'move_to',
    description: '把玩家移动到相邻地点，返回抵达描述。',
    parameters: {
      type: 'object',
      properties: { placeId: { type: 'string', description: '目标地点 id' } },
      required: ['placeId'],
    },
  },
  {
    name: 'check_inventory',
    description: '查看某个地点里可交互的物品或商品。',
    parameters: {
      type: 'object',
      properties: { placeId: { type: 'string', description: '地点 id' } },
      required: ['placeId'],
    },
  },
]
