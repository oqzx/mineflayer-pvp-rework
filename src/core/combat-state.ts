import type { Entity } from 'prismarine-entity'
import type { Vec3 } from 'vec3'

export type CombatPhase =
  | 'idle'
  | 'engaging'
  | 'combo'
  | 'backing-off'
  | 'critical-setup'
  | 'blocking'
  | 'stunned'
  | 'retreating'
  | 'eating'
  | 'pearling'
  | 'bow-combat'
  | 'dodging'
  | 'stuck'

export type ThreatLevel = 'none' | 'low' | 'medium' | 'high' | 'critical'

export type IncomingProjectile = {
  entity: Entity
  type: 'arrow' | 'fireball' | 'pearl' | 'other'
  estimatedImpactTick: number
  impactPosition: Vec3
}

export type AimingEntity = {
  entity: Entity
  type: 'arrow' | 'fireball' | 'pearl' | 'other'
  estimatedImpactTick: number
  impactPosition: Vec3
}

export type CombatSnapshot = {
  phase: CombatPhase
  target: Entity | undefined
  targets: Entity[]
  threatLevel: ThreatLevel
  incomingProjectiles: IncomingProjectile[]
  aimingEntities: AimingEntity[]
  tick: number
  botHealth: number
  targetHealth: number | undefined
  inRange: boolean
  visible: boolean
  comboActive: boolean
  ticksSinceHurt: number
  ticksSinceTargetHurt: number
  ticksSinceLastHit: number
  ticksToNextAttack: number
  isOnGround: boolean
  verticalVelocity: number
  predictedTargetPosition: Vec3 | undefined
}

export function createSnapshot(): CombatSnapshot {
  return {
    phase: 'idle',
    target: undefined,
    targets: [],
    threatLevel: 'none',
    incomingProjectiles: [],
    aimingEntities: [],
    tick: 0,
    botHealth: 20,
    targetHealth: undefined,
    inRange: false,
    visible: false,
    comboActive: false,
    ticksSinceHurt: 999,
    ticksSinceTargetHurt: 999,
    ticksSinceLastHit: 999,
    ticksToNextAttack: 0,
    isOnGround: true,
    verticalVelocity: 0,
    predictedTargetPosition: undefined,
  }
}
