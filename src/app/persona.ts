/** 人物库编排：原型 ↔ 空间实例。UI 只调这一层，页面里不出现领域规则。 */

import { DomainError, ERR } from '../domain/errors'
import { makeId } from '../domain/ids'
import { hasPersonaInSpace, instantiatePersona, personaFromCast } from '../domain/persona'
import type { CastMember, Persona } from '../domain/types'
import type { SpaceRepo } from '../store/repo'

/** 把空间里的某个角色另存为原型（深拷贝，之后各走各的）。 */
export async function saveCastAsPersona(
  repo: SpaceRepo,
  spaceId: string,
  castId: string,
  now = Date.now(),
): Promise<Persona> {
  const canon = await repo.loadCanon(spaceId)
  const cast = canon.cast.find((c) => c.id === castId && c.removedAt === null)
  if (!cast) throw new DomainError(ERR.BAD_REQUEST, '找不到这个角色')
  const persona = personaFromCast(cast, (p) => makeId(p, now), now)
  return repo.savePersona(persona)
}

/**
 * 导入原型：同一空间内同一原型只能有一个实例。
 *
 * 不加这条限制，玩家会导入两个「林昭」，而抽取时的同名判定会把它们合并，
 * 故事线随即串味——这类错误一旦发生，回退都救不回来。
 */
export async function importPersonaIntoSpace(
  repo: SpaceRepo,
  spaceId: string,
  personaId: string,
  now = Date.now(),
): Promise<CastMember> {
  const persona = await repo.loadPersona(personaId)
  if (!persona) throw new DomainError(ERR.BAD_REQUEST, '找不到这个原型')
  const canon = await repo.loadCanon(spaceId)
  if (hasPersonaInSpace(canon.cast, personaId)) {
    throw new DomainError(ERR.BAD_REQUEST, '这个人在本空间已存在')
  }
  const member = instantiatePersona({
    persona,
    spaceId,
    sceneId: null,
    idGen: (p) => makeId(p, now),
  })
  canon.cast.push(member)
  await repo.saveCanon(spaceId, canon)
  return member
}
