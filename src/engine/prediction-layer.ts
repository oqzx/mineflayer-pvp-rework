import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import type { EnemyProfile } from '../adaptation/session-memory.js'
import type { PredictionConfig } from '../config/types.js'

export type StrafeProbability = {
  left: number
  right: number
  none: number
}

export type PredictionFrame = {
  predictedPosition: Vec3
  predictedVelocity: Vec3
  predictedPositionT3: Vec3
  predictedPositionT5: Vec3
  strafeDirectionProbability: StrafeProbability
  attackProbability: number
  blockProbability: number
  retreatProbability: number
  hitChanceEstimate: number
  optimalAttackDelayTicks: number
  criticalWindowOpen: boolean
  angularVelocity: number
  closingSpeed: number
  isAccelerating: boolean
  isDecelerating: boolean
  isTurning: boolean
  turnRate: number
  velocityMagnitude: number
  exposureScore: number
  predictedGapDistance: number
  isFleeingLikely: boolean
  isComboWindowOpen: boolean
  swingAnimationProgress: number
  strafeFrequencyEstimate: number
  nextStrafeChangeProbability: number
  postHitBehaviorPredicted: 'aggressive' | 'defensive' | 'neutral'
}

type VelocitySample = {
  velocity: Vec3
  position: Vec3
  tick: number
}

function vectorMag(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export class PredictionLayer {
  private readonly velocityHistory: VelocitySample[] = []
  private readonly attackTickHistory: number[] = []
  private smoothedVelocity: Vec3 = new Vec3(0, 0, 0)
  private prevSmoothedVelocity: Vec3 = new Vec3(0, 0, 0)
  private prevYaw = 0
  private lastYaw = 0
  private ticksSinceLastStrafe = 0
  private consecutiveStrafeDir: 'left' | 'right' | 'none' = 'none'
  private strafeChangeTicks: number[] = []
  private lastFrame: PredictionFrame | null = null

  constructor(private readonly config: PredictionConfig) {}

  update(target: Entity, botPosition: Vec3, tick: number, profile: EnemyProfile): PredictionFrame {
    if (!this.config.enabled) {
      return this.defaultFrame(target.position)
    }

    this.recordVelocitySample(target, tick)
    this.updateSmoothedVelocity(target.velocity)
    this.updateStrafeTracking(target, tick)

    const predictedVelocity = this.predictNextVelocity()
    const leadTicks = this.config.positionLeadTicks
    const predictedPosition = this.predictPosition(target.position, predictedVelocity, leadTicks)
    const predictedPositionT3 = this.predictPosition(target.position, predictedVelocity, 3)
    const predictedPositionT5 = this.predictPosition(target.position, predictedVelocity, 5)

    const currentMag = vectorMag(this.smoothedVelocity)
    const prevMag = vectorMag(this.prevSmoothedVelocity)
    const isAccelerating = currentMag > prevMag + 0.01
    const isDecelerating = currentMag < prevMag - 0.01

    const angularVelocity = this.computeAngularVelocity(target)
    const isTurning = Math.abs(angularVelocity) > 0.05
    const turnRate = angularVelocity

    const closingSpeed = this.computeClosingSpeed(target.position, predictedVelocity, botPosition)
    const isFleeingLikely = closingSpeed < -0.08 && profile.retreatHealthEstimate > 0

    const strafeProbability = this.computeStrafeProbability(profile)
    const attackProbability = this.computeAttackProbability(tick, profile)
    const blockProbability = profile.blockingRatio * (1 - attackProbability * 0.6)
    const retreatProbability = isFleeingLikely
      ? 0.7
      : sigmoid((profile.aggressionScore - 0.5) * -6) * 0.4

    const hitChanceEstimate = this.computeHitChance(target, botPosition, isTurning, currentMag)
    const optimalAttackDelayTicks = this.computeOptimalAttackDelay(profile, attackProbability)
    const criticalWindowOpen = this.isCriticalWindow(target, profile)
    const exposureScore = this.computeExposure(target, botPosition, isTurning)
    const predictedGapDistance = target.position.distanceTo(botPosition) + closingSpeed * leadTicks
    const isComboWindowOpen = profile.averageCps > 8 && attackProbability > 0.5
    const swingAnimationProgress = this.estimateSwingProgress(tick, profile)
    const strafeFrequencyEstimate = profile.directionChangeRate * 20
    const nextStrafeChangeProbability = this.computeNextStrafeChange(profile)

    const postHitBehaviorPredicted: 'aggressive' | 'defensive' | 'neutral' =
      profile.aggressionScore > 0.65
        ? 'aggressive'
        : profile.blockingRatio > 0.5
          ? 'defensive'
          : 'neutral'

    const frame: PredictionFrame = {
      predictedPosition,
      predictedVelocity,
      predictedPositionT3,
      predictedPositionT5,
      strafeDirectionProbability: strafeProbability,
      attackProbability,
      blockProbability,
      retreatProbability,
      hitChanceEstimate,
      optimalAttackDelayTicks,
      criticalWindowOpen,
      angularVelocity,
      closingSpeed,
      isAccelerating,
      isDecelerating,
      isTurning,
      turnRate,
      velocityMagnitude: currentMag,
      exposureScore,
      predictedGapDistance,
      isFleeingLikely,
      isComboWindowOpen,
      swingAnimationProgress,
      strafeFrequencyEstimate,
      nextStrafeChangeProbability,
      postHitBehaviorPredicted,
    }

    this.lastFrame = frame
    this.prevSmoothedVelocity = this.smoothedVelocity.clone()
    return frame
  }

  getLast(): PredictionFrame | null {
    return this.lastFrame
  }

  private recordVelocitySample(target: Entity, tick: number): void {
    this.velocityHistory.push({
      velocity: target.velocity.clone(),
      position: target.position.clone(),
      tick,
    })
    const maxLen = this.config.velocityHistoryLen
    if (this.velocityHistory.length > maxLen) this.velocityHistory.shift()
  }

  private updateSmoothedVelocity(rawVelocity: Vec3): void {
    const alpha = 0.35
    this.smoothedVelocity = new Vec3(
      lerp(this.smoothedVelocity.x, rawVelocity.x, alpha),
      lerp(this.smoothedVelocity.y, rawVelocity.y, alpha),
      lerp(this.smoothedVelocity.z, rawVelocity.z, alpha),
    )
  }

  private updateStrafeTracking(target: Entity, tick: number): void {
    this.prevYaw = this.lastYaw
    this.lastYaw = target.yaw
    this.ticksSinceLastStrafe++

    const dx = this.smoothedVelocity.x
    const dz = this.smoothedVelocity.z
    const lateral = Math.abs(dx) > 0.02 || Math.abs(dz) > 0.02
    if (!lateral) {
      this.consecutiveStrafeDir = 'none'
      return
    }

    const cross = target.yaw
    const newDir: 'left' | 'right' = cross > 0 ? 'left' : 'right'
    if (newDir !== this.consecutiveStrafeDir && this.consecutiveStrafeDir !== 'none') {
      this.strafeChangeTicks.push(tick)
      this.ticksSinceLastStrafe = 0
      if (this.strafeChangeTicks.length > 20) this.strafeChangeTicks.shift()
    }
    this.consecutiveStrafeDir = newDir
  }

  private predictNextVelocity(): Vec3 {
    const hist = this.velocityHistory
    if (hist.length < 3) return this.smoothedVelocity.clone()

    const n = hist.length
    const last = hist[n - 1]
    const prev = hist[n - 2]
    if (last === undefined || prev === undefined) return this.smoothedVelocity.clone()

    const accel = new Vec3(
      last.velocity.x - prev.velocity.x,
      last.velocity.y - prev.velocity.y,
      last.velocity.z - prev.velocity.z,
    )

    return new Vec3(
      this.smoothedVelocity.x + accel.x * 0.5,
      this.smoothedVelocity.y + accel.y * 0.3,
      this.smoothedVelocity.z + accel.z * 0.5,
    )
  }

  private predictPosition(currentPos: Vec3, velocity: Vec3, ticks: number): Vec3 {
    const drag = 0.91
    let x = currentPos.x
    let y = currentPos.y
    let z = currentPos.z
    let vx = velocity.x
    let vy = velocity.y
    let vz = velocity.z

    for (let t = 0; t < ticks; t++) {
      x += vx
      y += vy
      z += vz
      vx *= drag
      vy = (vy - 0.08) * 0.98
      vz *= drag
    }
    return new Vec3(x, y, z)
  }

  private computeAngularVelocity(target: Entity): number {
    const dYaw = target.yaw - this.prevYaw
    return dYaw
  }

  private computeClosingSpeed(targetPos: Vec3, targetVel: Vec3, botPos: Vec3): number {
    const toBot = botPos.minus(targetPos)
    const dist = vectorMag(toBot)
    if (dist < 0.001) return 0
    const unitToBot = toBot.scaled(1 / dist)
    return targetVel.x * unitToBot.x + targetVel.y * unitToBot.y + targetVel.z * unitToBot.z
  }

  private computeStrafeProbability(profile: EnemyProfile): StrafeProbability {
    const leftBase = profile.preferredStrafeDir === 'left' ? 0.65 : 0.25
    const rightBase = profile.preferredStrafeDir === 'right' ? 0.65 : 0.25
    const entropy = profile.movementPatternEntropy

    const left = lerp(leftBase, 0.33, entropy)
    const right = lerp(rightBase, 0.33, entropy)
    const none = Math.max(0, 1 - left - right)

    const total = left + right + none
    return { left: left / total, right: right / total, none: none / total }
  }

  private computeAttackProbability(tick: number, profile: EnemyProfile): number {
    const avgInterval = profile.averageSwingInterval
    if (avgInterval <= 0 || this.attackTickHistory.length === 0) return 0.5
    const lastAttackTick = this.attackTickHistory[this.attackTickHistory.length - 1]
    if (lastAttackTick === undefined) return 0.5
    const ticksSinceLast = tick - lastAttackTick
    const normalized = ticksSinceLast / avgInterval
    return sigmoid((normalized - 1) * 4)
  }

  private computeHitChance(
    target: Entity,
    botPos: Vec3,
    isTurning: boolean,
    velMag: number,
  ): number {
    const dist = target.position.distanceTo(botPos)
    const distScore = Math.max(0, 1 - dist / 4.0)
    const movementPenalty = isTurning ? 0.2 : 0
    const velocityPenalty = Math.min(0.3, velMag * 2)
    return Math.min(1, Math.max(0, distScore - movementPenalty - velocityPenalty + 0.1))
  }

  private computeOptimalAttackDelay(profile: EnemyProfile, attackProb: number): number {
    if (attackProb < 0.3) return 0
    const avgInterval = profile.averageSwingInterval
    return Math.max(0, Math.round(avgInterval * (1 - attackProb)))
  }

  private isCriticalWindow(target: Entity, profile: EnemyProfile): boolean {
    const velY = target.velocity.y
    const isFalling = velY < -0.1
    const critLikely = profile.criticalHitRate > 0.2
    return isFalling && critLikely
  }

  private computeExposure(target: Entity, botPos: Vec3, isTurning: boolean): number {
    const dist = target.position.distanceTo(botPos)
    const distFactor = Math.max(0, 1 - dist / 5)
    const turningBonus = isTurning ? 0.2 : 0
    const velFactor = Math.min(0.3, vectorMag(this.smoothedVelocity) * 1.5)
    return Math.min(1, distFactor + turningBonus - velFactor)
  }

  private estimateSwingProgress(tick: number, profile: EnemyProfile): number {
    if (this.attackTickHistory.length === 0) return 0
    const lastAttackTick = this.attackTickHistory[this.attackTickHistory.length - 1]
    if (lastAttackTick === undefined) return 0
    const elapsed = tick - lastAttackTick
    const interval = profile.averageSwingInterval
    if (interval <= 0) return 0
    return Math.min(1, elapsed / interval)
  }

  private computeNextStrafeChange(profile: EnemyProfile): number {
    const changeRate = profile.directionChangeRate
    const ticksSince = this.ticksSinceLastStrafe
    const avgChangeTicks = changeRate > 0 ? 1 / changeRate : 20
    return sigmoid((ticksSince - avgChangeTicks) * 0.5)
  }

  recordEnemyAttack(tick: number): void {
    this.attackTickHistory.push(tick)
    const maxLen = this.config.attackPatternMemoryLen
    if (this.attackTickHistory.length > maxLen) this.attackTickHistory.shift()
  }

  private defaultFrame(position: Vec3): PredictionFrame {
    return {
      predictedPosition: position.clone(),
      predictedVelocity: new Vec3(0, 0, 0),
      predictedPositionT3: position.clone(),
      predictedPositionT5: position.clone(),
      strafeDirectionProbability: { left: 0.33, right: 0.33, none: 0.34 },
      attackProbability: 0.5,
      blockProbability: 0.2,
      retreatProbability: 0.1,
      hitChanceEstimate: 0.7,
      optimalAttackDelayTicks: 0,
      criticalWindowOpen: false,
      angularVelocity: 0,
      closingSpeed: 0,
      isAccelerating: false,
      isDecelerating: false,
      isTurning: false,
      turnRate: 0,
      velocityMagnitude: 0,
      exposureScore: 0.5,
      predictedGapDistance: 3,
      isFleeingLikely: false,
      isComboWindowOpen: false,
      swingAnimationProgress: 0,
      strafeFrequencyEstimate: 0.5,
      nextStrafeChangeProbability: 0.3,
      postHitBehaviorPredicted: 'neutral',
    }
  }
}
