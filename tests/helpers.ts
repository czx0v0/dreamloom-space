import type { CanonState, CastMember, Place, Relation, World } from '../src/domain/types'

export function makeWorld(over: Partial<World> = {}): World {
  return {
    name: '雾港',
    era: '民国',
    theme: '真相值不值得',
    premise: '一桩旧案把所有人重新钉在同一张桌上',
    oneLine: '港口多雾，雾里有人撒谎',
    rules: ['雾港没有警察'],
    factions: ['码头帮'],
    updatedAt: 0,
    ...over,
  }
}

let seq = 0
export function makeCast(over: Partial<CastMember> = {}): CastMember {
  seq += 1
  return {
    id: `ch_${seq}`,
    spaceId: 'sp_1',
    personaId: null,
    personaRev: null,
    name: '林昭',
    aliases: [],
    role: 'protagonist',
    status: 'alive',
    statusChangedSceneId: null,
    oneLine: '',
    voice: '',
    traits: [],
    secrets: [],
    goal: '',
    abilities: [],
    hobbies: [],
    hidden: [],
    arc: [],
    interactions: [],
    firstSeenSceneId: 'sc_1',
    lastSeenSceneId: 'sc_1',
    lastSeenPlaceId: null,
    locked: {},
    origin: 'user',
    confidence: 1,
    supersededBy: null,
    removedAt: null,
    ...over,
  }
}

export function makePlace(over: Partial<Place> = {}): Place {
  seq += 1
  return {
    id: `pl_${seq}`,
    spaceId: 'sp_1',
    name: '同福客栈',
    kind: '客栈',
    oneLine: '',
    features: [],
    inventory: [],
    events: [],
    exits: [],
    parentId: null,
    interactions: [],
    coords: null,
    firstSeenSceneId: 'sc_1',
    locked: {},
    supersededBy: null,
    removedAt: null,
    ...over,
  }
}

export function makeRelation(over: Partial<Relation> = {}): Relation {
  seq += 1
  return {
    id: `rl_${seq}`,
    spaceId: 'sp_1',
    aId: 'ch_1',
    bId: 'ch_2',
    kind: 'enemy',
    strength: 3,
    note: '',
    edgeKey: 'ch_1|ch_2|enemy',
    firstSeenSceneId: 'sc_1',
    ...over,
  }
}

export function makeState(over: Partial<CanonState> = {}): CanonState {
  return {
    world: makeWorld(),
    cast: [],
    places: [],
    relations: [],
    facts: [],
    ...over,
  }
}

export function idGenFactory() {
  let n = 0
  return (prefix: string) => `${prefix}_test${++n}`
}
