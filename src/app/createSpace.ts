/** 建空间：模板 / 随机 / 手写三条路，最后都落到 `repo.createSpace`。 */

import type { CharPreset, SpaceMeta } from '../domain/types'
import type { CreateDefaults, SpaceRepo } from '../store/repo'
import { pickTemplate, type SeedTemplate } from '../store/seed'

export interface CreateSpaceArgs {
  repo: SpaceRepo
  title: string
  cover?: string
  genre?: string
  tone?: string
  preset?: CharPreset
  defaults?: CreateDefaults
  world: SeedTemplate['world']
  cast: SeedTemplate['cast']
  places: SeedTemplate['places']
  mainGoal?: string
  hardRules?: string[]
}

export async function createSpaceFromSeed(args: CreateSpaceArgs): Promise<SpaceMeta> {
  const { repo } = args
  return repo.createSpace({
    title: args.title,
    cover: args.cover,
    genre: args.genre,
    tone: args.tone,
    preset: args.preset,
    defaults: args.defaults,
    mainGoal: args.mainGoal,
    hardRules: args.hardRules,
    world: {
      name: args.world.name,
      era: args.world.era,
      theme: args.world.theme,
      premise: args.world.premise,
      oneLine: args.world.oneLine,
      rules: args.world.rules,
      factions: args.world.factions,
    },
    cast: args.cast.map((c) => ({
      name: c.name,
      role: c.role,
      oneLine: c.oneLine,
      voice: c.voice,
      traits: c.traits,
      secrets: c.secrets,
    })),
    places: args.places.map((p) => ({
      name: p.name,
      kind: p.kind,
      oneLine: p.oneLine,
      features: p.features,
    })),
  })
}

/** 从模板建：标题默认用模板名。 */
export function createSpaceFromTemplate(
  repo: SpaceRepo,
  template: SeedTemplate,
  overrides: Partial<Pick<CreateSpaceArgs, 'title' | 'preset' | 'defaults' | 'mainGoal'>> = {},
): Promise<SpaceMeta> {
  return createSpaceFromSeed({
    repo,
    title: overrides.title ?? template.name,
    cover: template.cover,
    genre: template.genre,
    tone: template.tone,
    preset: overrides.preset,
    defaults: overrides.defaults,
    mainGoal: overrides.mainGoal ?? template.tagline,
    world: template.world,
    cast: template.cast,
    places: template.places,
  })
}

/** 随机：随机取一个模板，标题加一个四字后缀避免完全重名。 */
export function createSpaceRandom(
  repo: SpaceRepo,
  rand?: () => number,
  defaults?: CreateDefaults,
): Promise<SpaceMeta> {
  const template = pickTemplate(rand)
  return createSpaceFromTemplate(repo, template, { title: `${template.name}·另起`, defaults })
}

export interface ManualInput {
  title: string
  worldName: string
  era: string
  premise: string
  mainGoal: string
  rules: string[]
  protagonist: { name: string; oneLine: string; voice: string }
  place: { name: string; kind: string; oneLine: string }
}

/** 手写：最少一个主角、一个地点，其余交给抽取补。 */
export function createSpaceManual(
  repo: SpaceRepo,
  input: ManualInput,
  preset?: CharPreset,
  defaults?: CreateDefaults,
) {
  return createSpaceFromSeed({
    repo,
    title: input.title.trim() || '未命名空间',
    cover: '📖',
    genre: '自定义',
    tone: '克制',
    preset,
    defaults,
    mainGoal: input.mainGoal,
    world: {
      name: input.worldName || input.title,
      era: input.era,
      theme: '',
      premise: input.premise,
      oneLine: input.premise,
      rules: input.rules.filter(Boolean),
      factions: [],
      updatedAt: 0,
    },
    cast: [
      {
        name: input.protagonist.name.trim() || '主角',
        role: 'protagonist',
        oneLine: input.protagonist.oneLine,
        voice: input.protagonist.voice,
        traits: [],
        secrets: [],
      },
    ],
    places: [
      {
        name: input.place.name.trim() || '起点',
        kind: input.place.kind || '场所',
        oneLine: input.place.oneLine,
        features: [],
      },
    ],
  })
}
