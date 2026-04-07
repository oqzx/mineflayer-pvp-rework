import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { ThreatLevel } from '../core/combat-state.js'

const WEAPON_WEIGHTS: Record<string, number> = {
  netherite_sword: 1.0,
  diamond_sword: 0.95,
  iron_sword: 0.85,
  stone_sword: 0.75,
  golden_sword: 0.7,
  wooden_sword: 0.65,
  netherite_axe: 0.9,
  diamond_axe: 0.85,
  bow: 0.7,
  crossbow: 0.75,
}

function getWeaponWeight(entity: Entity): number {
  const name = entity.heldItem?.name ?? ''
  return WEAPON_WEIGHTS[name] ?? 0.5
}

export type ThreatScore = {
  entity: Entity
  score: number
  level: ThreatLevel
  distance: number
}

export function assessThreat(bot: Bot, entity: Entity): ThreatScore {
  const dist = bot.entity.position.distanceTo(entity.position)
  const health = (entity.metadata[9] as number | undefined) ?? 20
  const weaponW = getWeaponWeight(entity)
  const proximityScore = Math.max(0, 1 - dist / 20)
  const healthScore = 1 - health / 40
  const score = proximityScore * 0.5 + weaponW * 0.3 + healthScore * 0.2

  let level: ThreatLevel = 'none'
  if (score > 0.8) level = 'critical'
  else if (score > 0.6) level = 'high'
  else if (score > 0.4) level = 'medium'
  else if (score > 0.15) level = 'low'

  return { entity, score, level, distance: dist }
}

export function rankThreats(bot: Bot, entities: Entity[]): ThreatScore[] {
  return entities.map((e) => assessThreat(bot, e)).sort((a, b) => b.score - a.score)
}
