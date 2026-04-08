import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { PearlConfig } from '../config/types.js'
import { simulateProjectile, closestApproachTick, solvePitch, solveAimIterative } from './trajectory.js'
import { VOID_DEPTH, MAX_PEARL_TICKS } from '../calc/constants.js'

export type PearlUsageReason = 'aggressive' | 'escape-void' | 'escape-fall' | 'repositioning'

type PearlAim = { yaw: number; pitch: number; landingPos: Vec3 }

export type EnemyPearlPrediction = {
  entity: Entity
  estimatedLandTick: number
  estimatedLandPos: Vec3
}

function hasEnderPearl(bot: Bot): boolean {
  return bot.inventory.items().some((i) => i.name === 'ender_pearl')
}

function findSafeLanding(bot: Bot, searchRadius: number, avoidPositions: Vec3[]): Vec3 | null {
  const origin = bot.entity.position
  const candidates: Vec3[] = []

  for (let dx = -searchRadius; dx <= searchRadius; dx += 2) {
    for (let dz = -searchRadius; dz <= searchRadius; dz += 2) {
      const check = origin.offset(dx, 0, dz)
      const ground = bot.blockAt(check.offset(0, -1, 0))
      const air1 = bot.blockAt(check)
      const air2 = bot.blockAt(check.offset(0, 1, 0))
      if (!ground || ground.name === 'air') continue
      if (air1?.name !== 'air' || air2?.name !== 'air') continue
      if (check.y < VOID_DEPTH + 16) continue
      candidates.push(check.clone())
    }
  }

  return (
    candidates
      .filter((pos) => avoidPositions.every((ap) => pos.distanceTo(ap) > 3))
      .sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin))[0] ?? null
  )
}

function aimToStaticPosition(eyePos: Vec3, target: Vec3): PearlAim | null {
  const dx = target.x - eyePos.x
  const dy = target.y - eyePos.y
  const dz = target.z - eyePos.z
  const hDist = Math.sqrt(dx * dx + dz * dz)
  const yaw = Math.atan2(dx, dz) + Math.PI

  const pitch = solvePitch(hDist, dy, 'ender_pearl')
  if (pitch === null) return null

  const sim = simulateProjectile(eyePos, yaw, pitch, 'ender_pearl', MAX_PEARL_TICKS)
  const closestTick = closestApproachTick(sim.points, target)
  const pt = sim.points[closestTick - 1]

  if (!pt || pt.position.distanceTo(target) > 3.5) return null

  return { yaw, pitch, landingPos: pt.position.clone() }
}

function isAboveVoid(bot: Bot): boolean {
  const pos = bot.entity.position
  for (let dy = -1; dy >= -VOID_DEPTH; dy--) {
    const block = bot.blockAt(pos.offset(0, dy, 0))
    if (block && block.name !== 'air') return false
  }
  return true
}

function estimateFallDamage(height: number): number {
  return Math.max(0, height - 3)
}

function getEyePos(bot: Bot): Vec3 {
  return bot.entity.position.offset(0, bot.entity.height * 0.9, 0)
}

export class PearlHandler {
  private throwing = false
  private readonly enemyPearlPredictions = new Map<number, EnemyPearlPrediction>()

  constructor(private readonly config: PearlConfig) {}

  get isThrowing(): boolean {
    return this.throwing
  }

  trackEnemyPearl(entity: Entity, tick: number): void {
    const sim = simulateProjectile(
      entity.position.offset(0, entity.height * 0.9, 0),
      entity.yaw,
      entity.pitch,
      'ender_pearl',
      MAX_PEARL_TICKS,
    )
    this.enemyPearlPredictions.set(entity.id, {
      entity,
      estimatedLandTick: tick + sim.totalTicks,
      estimatedLandPos: sim.finalPosition,
    })
  }

  getEnemyPearlPredictions(): EnemyPearlPrediction[] {
    return Array.from(this.enemyPearlPredictions.values())
  }

  removeEnemyPearl(entityId: number): void {
    this.enemyPearlPredictions.delete(entityId)
  }

  shouldThrowAggressive(bot: Bot, target: Entity): boolean {
    if (!this.config.enabled || this.throwing) return false
    if (!hasEnderPearl(bot)) return false
    return bot.entity.position.distanceTo(target.position) > this.config.aggressiveRange
  }

  shouldThrowDefensive(bot: Bot): boolean {
    if (!this.config.defensiveEnabled || this.throwing) return false
    if (!hasEnderPearl(bot)) return false

    if (isAboveVoid(bot) && bot.entity.velocity.y < -0.5) return true

    if (bot.entity.velocity.y >= -1.0) return false

    let height = 0
    for (let dy = -1; dy >= -20; dy--) {
      const block = bot.blockAt(bot.entity.position.offset(0, dy, 0))
      if (block && block.name !== 'air') {
        height = Math.abs(dy)
        break
      }
    }

    return estimateFallDamage(height) >= (bot.health ?? 20)
  }

  async throwAggressive(bot: Bot, target: Entity): Promise<boolean> {
    const eyePos = getEyePos(bot)
    const targetVel = (target as Entity & { velocity?: Vec3 }).velocity ?? new Vec3(0, 0, 0)

    const aim = solveAimIterative(
      eyePos,
      { position: target.position, velocity: targetVel, height: target.height },
      'ender_pearl',
      10,
    )

    if (!aim) return false
    return this.executeThrow(bot, aim.yaw, aim.pitch)
  }

  async throwDefensive(bot: Bot, enemies: Entity[]): Promise<boolean> {
    const eyePos = getEyePos(bot)
    const enemyPositions = enemies.map((e) => e.position)
    const safePos = findSafeLanding(bot, this.config.safeLandingSearchRadius, enemyPositions)
    if (!safePos) return false

    const aim = aimToStaticPosition(eyePos, safePos.offset(0.5, 0.5, 0.5))
    if (!aim) return false
    return this.executeThrow(bot, aim.yaw, aim.pitch)
  }

  private async executeThrow(bot: Bot, yaw: number, pitch: number): Promise<boolean> {
    if (this.throwing) return false
    const pearl = bot.inventory.items().find((i) => i.name === 'ender_pearl')
    if (!pearl) return false

    this.throwing = true
    try {
      await bot.util.inv.customEquip(pearl, 'hand')
      await bot.look(yaw, pitch, true)
      await bot.waitForTicks(1)
      bot.activateItem(false)
      await bot.waitForTicks(2)
      return true
    } finally {
      this.throwing = false
    }
  }
}
