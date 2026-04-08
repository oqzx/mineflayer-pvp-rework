import { Vec3 } from 'vec3'
import { AABBUtils } from '@nxg-org/mineflayer-util-plugin'
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Entity } from 'prismarine-entity'
import type { PearlConfig } from '../config/types.js'
import { simulateProjectile } from './trajectory.js'
import { VOID_DEPTH, MAX_PEARL_TICKS } from '../calc/constants.js'
import { ThrownPearlTracker } from './thrown-pearl-tracker.js'

export type PearlUsageReason = 'aggressive' | 'escape-void' | 'escape-fall' | 'repositioning'

export type EnemyPearlPrediction = {
  entity: Entity
  estimatedLandTick: number
  estimatedLandPos: Vec3
}

function findSafeLandingBlock(bot: Bot, searchRadius: number, avoidPositions: Vec3[]): Block | null {
  const origin = bot.entity.position
  const candidates: Block[] = []

  for (let dx = -searchRadius; dx <= searchRadius; dx += 2) {
    for (let dz = -searchRadius; dz <= searchRadius; dz += 2) {
      const check = origin.offset(dx, 0, dz)
      const ground = bot.blockAt(check.offset(0, -1, 0))
      const air1 = bot.blockAt(check)
      const air2 = bot.blockAt(check.offset(0, 1, 0))
      if (!ground || ground.name === 'air') continue
      if (air1?.name !== 'air' || air2?.name !== 'air') continue
      if (check.y < VOID_DEPTH + 16) continue
      candidates.push(ground)
    }
  }

  return (
    candidates
      .filter((block) => avoidPositions.every((ap) => block.position.offset(0.5, 1, 0.5).distanceTo(ap) > 3))
      .sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin))[0] ?? null
  )
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

type AggressivePearlPlan = {
  yaw: number
  pitch: number
}

type EscapePearlPlan = {
  block: Block
}

export class PearlHandler {
  private throwing = false
  private readonly tracker = ThrownPearlTracker.instance
  private readonly enemyPearlPredictions = new Map<number, EnemyPearlPrediction>()

  constructor(private readonly config: PearlConfig) {}

  get isThrowing(): boolean {
    return this.throwing
  }

  isPearlInProgress(bot: Bot): boolean {
    return this.throwing || this.tracker.isActive(bot)
  }

  getTrackerPhase(bot: Bot): string {
    return this.tracker.getPhase(bot)
  }

  canThrowPearl(bot: Bot): boolean {
    return !this.throwing && this.tracker.canStartThrow(bot) && bot.ender.hasPearls()
  }

  shouldEnterPearling(bot: Bot, target?: Entity, lowHealth = false): boolean {
    return this.getPearlingPlanType(bot, target, lowHealth) !== null
  }

  getPearlingDecisionReason(bot: Bot, target?: Entity, lowHealth = false): string {
    if (!this.config.enabled) return 'disabled'
    if (!bot.ender.hasPearls()) return 'no-pearls'
    if (this.throwing) return 'handler-throwing'

    const trackerPhase = this.getTrackerPhase(bot)
    if (trackerPhase !== 'idle') return `tracker:${trackerPhase}`

    const defensiveBlock = this.getDefensiveLandingBlock(bot)
    if (defensiveBlock) return `defensive:block=${defensiveBlock.position}`

    if (!target) return 'no-target'

    const escapePlan = lowHealth ? this.getEscapePlan(bot, target) : null
    if (escapePlan) {
      const distance = bot.entity.position.distanceTo(target.position)
      return `escape:distance=${distance.toFixed(2)} block=${escapePlan.block.position}`
    }

    const aggressiveShot = this.getAggressiveShot(bot, target)
    if (aggressiveShot) {
      const distance = bot.entity.position.distanceTo(target.position)
      return `aggressive:distance=${distance.toFixed(2)}`
    }

    const distance = bot.entity.position.distanceTo(target.position)
    if (distance <= this.config.aggressiveRange) return `blocked:distance=${distance.toFixed(2)}`
    return `blocked:no-shot distance=${distance.toFixed(2)}`
  }

  shouldThrowAggressive(bot: Bot, target: Entity): boolean {
    return this.getAggressiveShot(bot, target) !== null
  }

  shouldThrowDefensive(bot: Bot): boolean {
    return this.getDefensiveLandingBlock(bot) !== null
  }

  shouldThrowEscape(bot: Bot, enemy: Entity | null): boolean {
    if (!enemy) return false
    return this.getEscapePlan(bot, enemy) !== null
  }

  async throwAggressive(bot: Bot, target: Entity): Promise<boolean> {
    const shot = this.getAggressiveShot(bot, target)
    if (!shot) {
      console.log(
        `[pearl-handler] aggressive aborted target=${target.id} reason=no-shot phase=${this.getTrackerPhase(bot)}`,
      )
      return false
    }

    const bb = AABBUtils.getEntityAABB(target)
    console.log(
      `[pearl-handler] aggressive start target=${target.id} yaw=${shot.yaw.toFixed(3)} pitch=${shot.pitch.toFixed(3)} dist=${bot.entity.position.distanceTo(target.position).toFixed(2)}`,
    )
    return await this.executeThrow(bot, async () => {
      const result = await bot.ender.pearlAABB(bb, target.position)
      console.log(`[pearl-handler] aggressive end target=${target.id} result=${result}`)
      return result
    })
  }

  async throwDefensive(bot: Bot, enemies: Entity[]): Promise<boolean> {
    const safeBlock = this.getDefensiveLandingBlock(bot, enemies)
    if (!safeBlock) {
      console.log(`[pearl-handler] defensive aborted reason=no-safe-block phase=${this.getTrackerPhase(bot)}`)
      return false
    }

    console.log(`[pearl-handler] defensive start block=${safeBlock.position}`)
    return await this.executeThrow(bot, async () => {
      const result = await bot.ender.pearl(safeBlock)
      console.log(`[pearl-handler] defensive end result=${result}`)
      return result
    })
  }

  async throwEscape(bot: Bot, enemy: Entity): Promise<boolean> {
    const plan = this.getEscapePlan(bot, enemy)
    if (!plan) {
      console.log(`[pearl-handler] escape aborted enemy=${enemy.id} reason=no-safe-block phase=${this.getTrackerPhase(bot)}`)
      return false
    }

    console.log(
      `[pearl-handler] escape start enemy=${enemy.id} enemyDist=${bot.entity.position.distanceTo(enemy.position).toFixed(2)} block=${plan.block.position}`,
    )
    return await this.executeThrow(bot, async () => {
      const result = await bot.ender.pearl(plan.block)
      console.log(`[pearl-handler] escape end enemy=${enemy.id} result=${result}`)
      return result
    })
  }

  onEntitySpawn(bot: Bot, entity: Entity): void {
    this.tracker.onEntitySpawn(bot, entity)
  }

  onEntityGone(bot: Bot, entity: Entity): void {
    this.tracker.onEntityGone(bot, entity)
  }

  onBotMove(bot: Bot, previousPosition?: Vec3): void {
    this.tracker.onBotMove(bot, previousPosition)
  }

  onForcedMove(bot: Bot): void {
    this.tracker.onForcedMove(bot)
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

  private getPearlingPlanType(bot: Bot, target?: Entity, lowHealth = false): 'defensive' | 'escape' | 'aggressive' | null {
    if (this.getDefensiveLandingBlock(bot)) return 'defensive'
    if (lowHealth && target && this.getEscapePlan(bot, target)) return 'escape'
    if (target && this.getAggressiveShot(bot, target)) return 'aggressive'
    return null
  }

  private getAggressiveShot(bot: Bot, target: Entity): AggressivePearlPlan | null {
    if (!this.config.enabled || !this.canThrowPearl(bot)) return null
    if (bot.entity.position.distanceTo(target.position) <= this.config.aggressiveRange) return null

    const shot = bot.ender.shotToAABB(AABBUtils.getEntityAABB(target), target.position)
    if (!shot?.hit) return null

    return { yaw: shot.yaw, pitch: shot.pitch }
  }

  private getDefensiveLandingBlock(bot: Bot, enemies: Entity[] = []): Block | null {
    if (!this.config.defensiveEnabled || !this.canThrowPearl(bot)) return null

    if (!isAboveVoid(bot) || bot.entity.velocity.y >= -0.5) {
      if (bot.entity.velocity.y >= -1.0) return null

      let height = 0
      for (let dy = -1; dy >= -20; dy--) {
        const block = bot.blockAt(bot.entity.position.offset(0, dy, 0))
        if (block && block.name !== 'air') {
          height = Math.abs(dy)
          break
        }
      }

      if (estimateFallDamage(height) < (bot.health ?? 20)) return null
    }

    return findSafeLandingBlock(
      bot,
      this.config.safeLandingSearchRadius,
      enemies.map((enemy) => enemy.position),
    )
  }

  private getEscapePlan(bot: Bot, enemy: Entity): EscapePearlPlan | null {
    if (!this.config.enabled || !this.canThrowPearl(bot)) return null

    const distance = bot.entity.position.distanceTo(enemy.position)
    if (distance >= 8) return null

    const away = bot.entity.position.minus(enemy.position)
    const horizontalAway = new Vec3(away.x, 0, away.z)
    if (horizontalAway.norm() < 1e-6) return null

    const awayDir = horizontalAway.normalize()
    const jitters = [-2, 0, 2]

    for (let dist = 8; dist <= 20; dist += 4) {
      for (let yOff = 0; yOff <= 4; yOff++) {
        for (const xJitter of jitters) {
          for (const zJitter of jitters) {
            const candidate = bot.entity.position.offset(
              awayDir.x * dist + xJitter,
              yOff,
              awayDir.z * dist + zJitter,
            )
            const ground = bot.blockAt(candidate.offset(0, -1, 0))
            const air1 = bot.blockAt(candidate)
            const air2 = bot.blockAt(candidate.offset(0, 1, 0))
            if (!ground || ground.name === 'air') continue
            if (air1?.name !== 'air' || air2?.name !== 'air') continue

            const shot = bot.ender.shotToBlock(ground)
            if (!shot?.hit) continue
            return { block: ground }
          }
        }
      }
    }

    const fallback = findSafeLandingBlock(bot, this.config.safeLandingSearchRadius, [enemy.position])
    if (!fallback) return null

    const fallbackShot = bot.ender.shotToBlock(fallback)
    if (!fallbackShot?.hit) return null
    return { block: fallback }
  }

  private async executeThrow(bot: Bot, action: () => Promise<boolean | void>): Promise<boolean> {
    if (!this.tracker.beginThrow(bot, bot.entity.position)) {
      console.log(`[pearl-handler] executeThrow blocked phase=${this.getTrackerPhase(bot)}`)
      return false
    }

    this.throwing = true
    try {
      const result = await action()
      if (result === false) {
        this.tracker.cancelThrow(bot)
        console.log('[pearl-handler] executeThrow action returned false')
        return false
      }
      console.log('[pearl-handler] executeThrow action completed')
      return true
    } catch (error) {
      this.tracker.cancelThrow(bot)
      console.log(`[pearl-handler] executeThrow threw ${(error as Error).message}`)
      throw error
    } finally {
      this.throwing = false
    }
  }
}
