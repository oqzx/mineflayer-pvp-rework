import type { StateMachineData } from '@nxg-org/mineflayer-static-statemachine'
import type { Entity } from 'prismarine-entity'
import type { Vec3 } from 'vec3'
import type { FullConfig } from '../config/types.js'
import type { AimingEntity, CombatSnapshot, IncomingProjectile } from './combat-state.js'
import type { SwordCombat } from '../combat/sword-combat.js'
import type { ProjectileHandler } from '../projectile/projectile-handler.js'
import type { DodgeController } from '../movement/dodge-controller.js'
import type { HealthManager } from '../health/health-manager.js'
import type { GapHandler } from '../tactics/gap-handler.js'
import type { TargetSelector } from '../multi-enemy/target-selector.js'
import type { TeamHandler } from '../multi-enemy/team-handler.js'
import type { PotionHandler } from '../health/potion-handler.js'
import type { AutoBuff } from '@nxg-org/mineflayer-auto-buff'
import { createSnapshot } from './combat-state.js'

export interface PvpData extends StateMachineData {
  entity?: Entity
  config: FullConfig
  sword: SwordCombat
  projectile: ProjectileHandler
  dodge: DodgeController
  health: HealthManager
  gap: GapHandler
  potions: PotionHandler
  autoBuff: AutoBuff
  targetSelector: TargetSelector
  team: TeamHandler
  tick: number
  stuckWaterFailedPlacements: Set<string>
  incomingProjectiles: IncomingProjectile[]
  aimingEntities: AimingEntity[]
  snapshot: CombatSnapshot
}

export function createPvpData(
  config: FullConfig,
  sword: SwordCombat,
  projectile: ProjectileHandler,
  dodge: DodgeController,
  health: HealthManager,
  gap: GapHandler,
  potions: PotionHandler,
  autoBuff: AutoBuff,
  targetSelector: TargetSelector,
  team: TeamHandler,
): PvpData {
  return {
    config,
    sword,
    projectile,
    dodge,
    health,
    gap,
    potions,
    autoBuff,
    targetSelector,
    team,
    tick: 0,
    stuckWaterFailedPlacements: new Set<string>(),
    incomingProjectiles: [],
    aimingEntities: [],
    snapshot: createSnapshot(),
  }
}
