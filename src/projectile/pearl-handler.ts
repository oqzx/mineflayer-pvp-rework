import { Vec3 } from 'vec3'
import { AABB, AABBUtils, InterceptFunctions } from '@nxg-org/mineflayer-util-plugin'
import { EnderShotFactory } from '@nxg-org/mineflayer-ender'

import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Entity } from 'prismarine-entity'
import type { PearlConfig } from '../config/types.js'
import { VOID_DEPTH } from '../calc/constants.js'
import { ThrownPearlTracker } from './thrown-pearl-tracker.js'

export type PearlUsageReason = 'aggressive' | 'escape-void' | 'escape-fall' | 'repositioning'

export type EnemyPearlPrediction = {
  pearlEntity: Entity
  throwerId: number | null
  estimatedLandTick: number
  estimatedLandPos: Vec3
  estimatedDurationTicks: number
}

function findSafeLandingBlock(
  bot: Bot,
  searchRadius: number,
  avoidPositions: Vec3[],
): Block | null {
  const origin = bot.entity.position
  const candidates: Block[] = []
  const innerRadius = avoidPositions.length === 0 ? 0 : SAFE_LANDING_INNER_RADIUS

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
      .filter((block) =>
        block.position.offset(0.5, 1, 0.5).distanceTo(origin) >= innerRadius &&
        avoidPositions.every((ap) => block.position.offset(0.5, 1, 0.5).distanceTo(ap) > 3),
      )
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

type HuntdownPearlPlan = AggressivePearlPlan & {
  targetPos: Vec3
}

type EscapePearlPlan = {
  block: Block
}

type EscapePlanCacheEntry = {
  key: string
  plan: EscapePearlPlan | null
}

type EscapeCandidate = {
  block: Block
  score: number
}

const MIN_ESCAPE_TRIGGER_DISTANCE = 6
const SAFE_LANDING_INNER_RADIUS = 8
const ESCAPE_INNER_RADIUS = 24
const ESCAPE_OUTER_RADIUS = 36
const MIN_ESCAPE_LANDING_DISTANCE = ESCAPE_INNER_RADIUS
const MIN_ESCAPE_DISTANCE_GAIN = 8
const MAX_ESCAPE_SHOT_CHECKS = 8
const ENDER_PEARL_DAMAGE = 5

export class PearlHandler {
  private throwing = false
  private readonly tracker = ThrownPearlTracker.instance
  private readonly enemyPearlPredictions = new Map<number, EnemyPearlPrediction>()
  private escapePlanCache: EscapePlanCacheEntry | null = null

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

  canSurvivePearl(bot: Bot): boolean {
    return (bot.health ?? 20) > ENDER_PEARL_DAMAGE
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

    const huntdownShot = this.getThrowHuntdownShot(bot, target)
    if (huntdownShot) {
      return `throwHuntdown:land=${huntdownShot.targetPos}`
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
    return (
      this.getThrowHuntdownShot(bot, target) !== null ||
      this.getAggressiveShot(bot, target) !== null
    )
  }

  shouldThrowDefensive(bot: Bot): boolean {
    return this.getDefensiveLandingBlock(bot) !== null
  }

  shouldThrowEscape(bot: Bot, enemy: Entity | null): boolean {
    if (!enemy) return false
    return this.getEscapePlan(bot, enemy) !== null
  }

  async throwAggressive(bot: Bot, target: Entity): Promise<boolean> {
    const huntdownShot = this.getThrowHuntdownShot(bot, target)
    if (huntdownShot) {
      const targetAABB = AABBUtils.getEntityAABBRaw({
        position: huntdownShot.targetPos,
        height: target.height,
        width: target.width ?? 0.6,
      })

      console.log(
        `[pearl-handler] throwHuntdown start target=${target.id} yaw=${huntdownShot.yaw.toFixed(3)} pitch=${huntdownShot.pitch.toFixed(3)} land=${huntdownShot.targetPos}`,
      )
      return await this.executeThrow(bot, async () => {
        const result = await bot.ender.pearlAABB(targetAABB, huntdownShot.targetPos)
        console.log(`[pearl-handler] throwHuntdown end target=${target.id} result=${result}`)
        return result
      })
    }

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
      console.log(
        `[pearl-handler] defensive aborted reason=no-safe-block phase=${this.getTrackerPhase(bot)}`,
      )
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
      console.log(
        `[pearl-handler] escape aborted enemy=${enemy.id} reason=no-safe-block phase=${this.getTrackerPhase(bot)}`,
      )
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

  onEntitySpawn(bot: Bot, entity: Entity, tick?: number, target?: Entity): void {
    this.clearPlanCaches()
    this.tracker.onEntitySpawn(bot, entity)
    if (tick !== undefined) this.trackEnemyPearl(bot, entity, tick, target)
  }

  onEntityGone(bot: Bot, entity: Entity): void {
    this.clearPlanCaches()
    this.tracker.onEntityGone(bot, entity)
    this.removeEnemyPearl(entity.id)
  }

  onBotMove(bot: Bot, previousPosition?: Vec3): void {
    this.clearPlanCaches()
    this.tracker.onBotMove(bot, previousPosition)
  }

  onForcedMove(bot: Bot): void {
    this.clearPlanCaches()
    this.tracker.onForcedMove(bot)
  }

  trackEnemyPearl(bot: Bot, entity: Entity, tick: number, target?: Entity): void {
    if (!this.config.throwHuntdown) return
    if (!entity.name?.includes('pearl')) return
    console.log(entity.name, entity)

    const closestPlayer = Object.values(bot.entities)
      .filter((candidate): candidate is Entity => {
        return candidate.type === 'player' && candidate.id !== bot.entity.id
      })
      .sort(
        (a, b) =>
          entity.position.xzDistanceTo(a.position) - entity.position.xzDistanceTo(b.position),
      )[0]

    const throwerId = closestPlayer?.id ?? null

    if (throwerId === null) return

    if (throwerId !== target?.id) {
      console.log(`Thrower didn't match. ${throwerId} vs ${target?.id}`)
    }

    // const mag = Math.sqrt(Math.pow(entity.velocity.x, 2) + Math.pow(entity.velocity.y, 2) + Math.pow(entity.velocity.z, 2))
    // console.log(`Tracking pearl ${entity.id} from thrower ${throwerId} with velocity ${entity.velocity} (mag=${mag.toFixed(2)})`)

    const calcs = new InterceptFunctions(bot)
    const shot = EnderShotFactory.fromEntity(entity, bot, calcs)

    const fakePos = new Vec3(0, 0, 0)
    const sim = shot.calcToAABB(AABB.fromBlock(fakePos), fakePos, true)

    // console.log(sim, shot.points, shot.pointVelocities)
    // console.log(shot.points.map((p) => p.toString()).join(' -> '), `simulated land=${sim.block?.position.offset(0,1,0) ?? 'unknown'} in ${sim.totalTicks} ticks`)
    // map all velocity magntidues.
    // const mags = shot.pointVelocities.map((v) => Math.sqrt(Math.pow(v.x, 2) + Math.pow(v.y, 2) + Math.pow(v.z, 2)))
    // console.log('velocity mags', mags.map((m) => m.toFixed(2)).join(', '))

    const landing = sim.block?.position.offset(0, 1, 0) ?? fakePos
    this.enemyPearlPredictions.set(entity.id, {
      pearlEntity: entity,
      throwerId,
      estimatedLandTick: tick + sim.totalTicks,
      estimatedDurationTicks: sim.totalTicks,
      estimatedLandPos: landing,
    })
    console.log(
      `[pearl-handler] tracked enemy pearl pearl=${entity.id} thrower=${throwerId} target=${target?.id} land=${landing} landTick=${sim.totalTicks}`,
    )
  }

  getEnemyPearlPredictions(): EnemyPearlPrediction[] {
    return Array.from(this.enemyPearlPredictions.values())
  }

  removeEnemyPearl(entityId: number): void {
    this.clearPlanCaches()
    this.enemyPearlPredictions.delete(entityId)
  }

  getPearlingPlanType(bot: Bot, target?: Entity, lowHealth = false): 'defensive' | 'escape' | 'aggressive' | null {
    if (this.getDefensiveLandingBlock(bot)) return 'defensive'
    if (lowHealth && target && this.getEscapePlan(bot, target)) return 'escape'
    if (target && this.getThrowHuntdownShot(bot, target)) return 'aggressive'
    if (target && this.getAggressiveShot(bot, target)) return 'aggressive'
    return null
  }

  private getThrowHuntdownShot(bot: Bot, target: Entity): HuntdownPearlPlan | null {
    if (!this.config.throwHuntdown || !this.config.enabled || !this.canThrowPearl(bot)) return null


    const prediction = Array.from(this.enemyPearlPredictions.values()).find(
      (entry) => entry.throwerId === target.id,
    )
    if (!prediction) return null

    const orgBlockPos = prediction.estimatedLandPos.offset(0.5, 0, 0.5)
    const orgBlockBB = AABBUtils.getEntityAABBRaw({
      position: orgBlockPos,
      height: 1,
      width: 3,
    })
    const tickAllowance = Math.floor(prediction.estimatedDurationTicks * 0.8);
    const predShot = bot.ender.shotToAABB(orgBlockBB, orgBlockPos, undefined, tickAllowance)

    if (!predShot?.hit) return null

    return {
      yaw: predShot.yaw,
      pitch: predShot.pitch,
      targetPos: orgBlockPos,
    }
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
    const cacheKey = this.getEscapePlanCacheKey(bot, enemy)
    if (this.escapePlanCache?.key === cacheKey) {
      return this.escapePlanCache.plan
    }

    if (!this.config.enabled || !this.canThrowPearl(bot)) return null

    const botPos = bot.entity.position
    const enemyPos = enemy.position
    const currentDistance = botPos.distanceTo(enemyPos)
    if (currentDistance >= MIN_ESCAPE_TRIGGER_DISTANCE) {
      this.escapePlanCache = { key: cacheKey, plan: null }
      return null
    }

    const away = botPos.minus(enemyPos)
    const horizontalAway = new Vec3(away.x, 0, away.z)
    if (horizontalAway.norm() < 1e-6) {
      this.escapePlanCache = { key: cacheKey, plan: null }
      return null
    }

    const awayDir = horizontalAway.normalize()
    const jitters = [-2, 0, 2]
    const candidates: EscapeCandidate[] = []

    for (let dist = ESCAPE_INNER_RADIUS; dist <= ESCAPE_OUTER_RADIUS; dist += 4) {
      for (let yOff = 0; yOff <= 4; yOff++) {
        for (const xJitter of jitters) {
          for (const zJitter of jitters) {
            const candidate = botPos.offset(
              awayDir.x * dist + xJitter,
              yOff,
              awayDir.z * dist + zJitter,
            )
            const ground = bot.blockAt(candidate.offset(0, -1, 0))
            const air1 = bot.blockAt(candidate)
            const air2 = bot.blockAt(candidate.offset(0, 1, 0))
            if (!ground || ground.name === 'air') continue
            if (air1?.name !== 'air' || air2?.name !== 'air') continue

            const landing = ground.position.offset(0.5, 1, 0.5)
            const enemyDistance = landing.distanceTo(enemyPos)
            const botDistance = landing.distanceTo(botPos)
            const distanceGain = enemyDistance - currentDistance
            if (botDistance < MIN_ESCAPE_LANDING_DISTANCE) continue
            if (distanceGain < MIN_ESCAPE_DISTANCE_GAIN) continue

            const alignment = awayDir.dot(landing.minus(botPos).normalize())
            const score =
              enemyDistance * 3.5 +
              botDistance * 1.5 +
              distanceGain * 4 +
              alignment * 5 -
              Math.abs(yOff) * 0.5 -
              (Math.abs(xJitter) + Math.abs(zJitter)) * 0.15

            candidates.push({ block: ground, score })
          }
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score)

    let bestPlan: EscapePearlPlan | null = null
    for (const candidate of candidates.slice(0, MAX_ESCAPE_SHOT_CHECKS)) {
      const shot = bot.ender.shotToBlock(candidate.block)
      if (!shot?.hit) continue
      bestPlan = { block: candidate.block }
      break
    }

    this.escapePlanCache = { key: cacheKey, plan: bestPlan }
    return bestPlan
  }

  private async executeThrow(bot: Bot, action: () => Promise<boolean | void>): Promise<boolean> {
    this.clearPlanCaches()
    if (!this.tracker.beginPrepareThrow(bot, bot.entity.position)) {
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
      this.tracker.markThrowSent(bot, bot.entity.position)
      console.log('[pearl-handler] executeThrow action completed')
      return true
    } catch (error) {
      this.tracker.cancelThrow(bot)
      console.log(`[pearl-handler] executeThrow threw ${(error as Error).message}`)
      throw error
    } finally {
      this.throwing = false
      this.clearPlanCaches()
    }
  }

  private clearPlanCaches(): void {
    this.escapePlanCache = null
  }

  private getEscapePlanCacheKey(bot: Bot, enemy: Entity): string {
    const botPos = bot.entity.position
    const enemyPos = enemy.position
    return [
      bot.time.age,
      this.throwing ? '1' : '0',
      this.getTrackerPhase(bot),
      enemy.id,
      botPos.x.toFixed(3),
      botPos.y.toFixed(3),
      botPos.z.toFixed(3),
      enemyPos.x.toFixed(3),
      enemyPos.y.toFixed(3),
      enemyPos.z.toFixed(3),
    ].join('|')
  }
}
