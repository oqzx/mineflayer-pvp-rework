export type AttackEvent = {
  tick: number
  wasBlocking: boolean
  wasWTapping: boolean
  hadCombo: boolean
  fromAbove: boolean
  reachDistance: number
}

export type MovementSample = {
  tick: number
  strafeDir: 'left' | 'right' | 'none'
  sprinting: boolean
  velocityMagnitude: number
  jumping: boolean
}

export type DamageSample = {
  tick: number
  amount: number
  wasCrit: boolean
}

export type BehaviorSample = {
  tick: number
  usedShield: boolean
  usedBow: boolean
  usedPearl: boolean
  usedPotion: boolean
  usedGapple: boolean
  usedAxe: boolean
}

export type EnemyProfile = {
  entityId: number
  attackTimestamps: number[]
  blockingRatio: number
  averageCps: number
  preferredStrafeDir: 'left' | 'right' | 'unpredictable'
  wTapFrequency: number
  bowUsageRatio: number
  attackSamples: AttackEvent[]
  movementSamples: MovementSample[]
  damageSamples: DamageSample[]
  behaviorSamples: BehaviorSample[]
  totalObservations: number

  aggressionScore: number
  comboHeaviness: number
  retreatHealthEstimate: number
  shieldUsageFrequency: number
  criticalHitRate: number
  averageSwingInterval: number
  swingIntervalVariance: number
  movementPatternEntropy: number
  velocityMagnitudeAverage: number
  velocityMagnitudeVariance: number
  strafeSpeedAverage: number
  postHitAggressive: boolean
  burstDamageRate: number
  sprintConsistency: number
  jumpFrequency: number
  directionChangeRate: number
  attackAngleVariance: number
  pearlUsageRatio: number
  potionUsageRatio: number
  gappleUsageRatio: number
  axeUsageRatio: number
  crossbowUsageRatio: number
  averageReachDistance: number
  hitFromAboveFrequency: number
  knockbackResistanceEstimate: number
  staggerFrequency: number
  timeBetweenCombos: number
  predictabilityScore: number
  latencyEstimate: number
  thornsDamageRatio: number
  combatEngagementRange: number
}

export function createProfile(entityId: number): EnemyProfile {
  return {
    entityId,
    attackTimestamps: [],
    blockingRatio: 0,
    averageCps: 0,
    preferredStrafeDir: 'unpredictable',
    wTapFrequency: 0,
    bowUsageRatio: 0,
    attackSamples: [],
    movementSamples: [],
    damageSamples: [],
    behaviorSamples: [],
    totalObservations: 0,
    aggressionScore: 0.5,
    comboHeaviness: 0.5,
    retreatHealthEstimate: 6,
    shieldUsageFrequency: 0,
    criticalHitRate: 0,
    averageSwingInterval: 10,
    swingIntervalVariance: 0,
    movementPatternEntropy: 0.5,
    velocityMagnitudeAverage: 0.2,
    velocityMagnitudeVariance: 0,
    strafeSpeedAverage: 0.1,
    postHitAggressive: true,
    burstDamageRate: 0,
    sprintConsistency: 0.8,
    jumpFrequency: 0.05,
    directionChangeRate: 0.1,
    attackAngleVariance: 0.5,
    pearlUsageRatio: 0,
    potionUsageRatio: 0,
    gappleUsageRatio: 0,
    axeUsageRatio: 0,
    crossbowUsageRatio: 0,
    averageReachDistance: 2.5,
    hitFromAboveFrequency: 0.1,
    knockbackResistanceEstimate: 0,
    staggerFrequency: 0.3,
    timeBetweenCombos: 40,
    predictabilityScore: 0.5,
    latencyEstimate: 0,
    thornsDamageRatio: 0,
    combatEngagementRange: 3.0,
  }
}

function shannonEntropy(counts: Record<string, number>): number {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (total === 0) return 0
  let entropy = 0
  for (const count of Object.values(counts)) {
    if (count === 0) continue
    const p = count / total
    entropy -= p * Math.log2(p)
  }
  return entropy
}

function ewma(prev: number, next: number, alpha: number): number {
  return alpha * next + (1 - alpha) * prev
}

export class SessionMemory {
  private readonly profiles = new Map<number, EnemyProfile>()

  getOrCreate(entityId: number): EnemyProfile {
    let profile = this.profiles.get(entityId)
    if (!profile) {
      profile = createProfile(entityId)
      this.profiles.set(entityId, profile)
    }
    return profile
  }

  get(entityId: number): EnemyProfile | undefined {
    return this.profiles.get(entityId)
  }

  recordAttack(
    entityId: number,
    tick: number,
    blocking: boolean,
    fromAbove: boolean,
    reachDistance: number,
  ): void {
    const profile = this.getOrCreate(entityId)
    profile.attackTimestamps.push(tick)
    if (profile.attackTimestamps.length > 50) profile.attackTimestamps.shift()

    profile.attackSamples.push({
      tick,
      wasBlocking: blocking,
      wasWTapping: false,
      hadCombo: false,
      fromAbove,
      reachDistance,
    })
    if (profile.attackSamples.length > 80) profile.attackSamples.shift()

    this.recomputeCps(profile)
    this.recomputeSwingInterval(profile)
    this.recomputeReachStats(profile)
    this.recomputeHitFromAbove(profile)
    this.recomputeBlockingRatio(profile)
    profile.totalObservations++
  }

  recordMovement(
    entityId: number,
    tick: number,
    strafeDir: 'left' | 'right' | 'none',
    sprinting: boolean,
    velocityMagnitude: number,
    jumping: boolean,
  ): void {
    const profile = this.getOrCreate(entityId)
    profile.movementSamples.push({ tick, strafeDir, sprinting, velocityMagnitude, jumping })
    if (profile.movementSamples.length > 100) profile.movementSamples.shift()
    this.recomputeStrafeDir(profile)
    this.recomputeVelocityStats(profile)
    this.recomputeJumpFrequency(profile)
    this.recomputeSprintConsistency(profile)
    this.recomputeDirectionChangeRate(profile)
    this.recomputeMovementEntropy(profile)
    profile.totalObservations++
  }

  recordDamage(entityId: number, tick: number, amount: number, wasCrit: boolean): void {
    const profile = this.getOrCreate(entityId)
    profile.damageSamples.push({ tick, amount, wasCrit })
    if (profile.damageSamples.length > 60) profile.damageSamples.shift()
    this.recomputeCritRate(profile)
    this.recomputeBurstDamage(profile)
  }

  recordBehavior(
    entityId: number,
    tick: number,
    usedShield: boolean,
    usedBow: boolean,
    usedPearl: boolean,
    usedPotion: boolean,
    usedGapple: boolean,
    usedAxe: boolean,
  ): void {
    const profile = this.getOrCreate(entityId)
    profile.behaviorSamples.push({
      tick,
      usedShield,
      usedBow,
      usedPearl,
      usedPotion,
      usedGapple,
      usedAxe,
    })
    if (profile.behaviorSamples.length > 80) profile.behaviorSamples.shift()
    this.recomputeBehaviorRatios(profile)
  }

  recordStagger(entityId: number): void {
    const profile = this.getOrCreate(entityId)
    const alpha = 0.15
    profile.staggerFrequency = ewma(profile.staggerFrequency, 1, alpha)
  }

  recordPostHitBehavior(entityId: number, wasAggressive: boolean): void {
    const profile = this.getOrCreate(entityId)
    const alpha = 0.1
    profile.aggressionScore = ewma(profile.aggressionScore, wasAggressive ? 1 : 0, alpha)
    profile.postHitAggressive = profile.aggressionScore > 0.5
  }

  recordComboInfo(entityId: number, hitsInWindow: number, ticksBetweenCombos: number): void {
    const profile = this.getOrCreate(entityId)
    profile.comboHeaviness = ewma(profile.comboHeaviness, Math.min(1, hitsInWindow / 5), 0.12)
    profile.timeBetweenCombos = ewma(profile.timeBetweenCombos, ticksBetweenCombos, 0.1)
  }

  estimateLatency(entityId: number, swingToHitTicks: number): void {
    const profile = this.getOrCreate(entityId)
    profile.latencyEstimate = ewma(profile.latencyEstimate, swingToHitTicks * 50, 0.1)
  }

  recordKnockbackResponse(entityId: number, resistedKb: boolean): void {
    const profile = this.getOrCreate(entityId)
    profile.knockbackResistanceEstimate = ewma(
      profile.knockbackResistanceEstimate,
      resistedKb ? 1 : 0,
      0.12,
    )
  }

  updatePredictability(entityId: number): void {
    const profile = this.getOrCreate(entityId)
    const entropy = profile.movementPatternEntropy
    const swingVar = profile.swingIntervalVariance
    const combined = entropy * 0.5 + Math.min(1, swingVar / 5) * 0.5
    profile.predictabilityScore = ewma(profile.predictabilityScore, combined, 0.05)
  }

  clear(entityId: number): void {
    this.profiles.delete(entityId)
  }

  private recomputeCps(profile: EnemyProfile): void {
    const timestamps = profile.attackTimestamps
    if (timestamps.length < 2) return
    const intervals: number[] = []
    for (let i = 1; i < timestamps.length; i++) {
      const curr = timestamps[i]
      const prev = timestamps[i - 1]
      if (curr === undefined || prev === undefined) continue
      const dt = (curr - prev) / 20
      if (dt > 0 && dt < 2) intervals.push(dt)
    }
    if (intervals.length === 0) return
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length
    profile.averageCps = Math.min(20, 1 / avgInterval)
  }

  private recomputeSwingInterval(profile: EnemyProfile): void {
    const timestamps = profile.attackTimestamps
    if (timestamps.length < 3) return
    const intervals: number[] = []
    for (let i = 1; i < timestamps.length; i++) {
      const curr = timestamps[i]
      const prev = timestamps[i - 1]
      if (curr === undefined || prev === undefined) continue
      const dt = curr - prev
      if (dt > 0 && dt < 40) intervals.push(dt)
    }
    if (intervals.length === 0) return
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length
    const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length
    profile.averageSwingInterval = mean
    profile.swingIntervalVariance = Math.sqrt(variance)
    profile.latencyEstimate = ewma(
      profile.latencyEstimate,
      profile.swingIntervalVariance * 20,
      0.08,
    )
  }

  private recomputeStrafeDir(profile: EnemyProfile): void {
    const recent = profile.movementSamples.slice(-30)
    const leftCount = recent.filter((s) => s.strafeDir === 'left').length
    const rightCount = recent.filter((s) => s.strafeDir === 'right').length
    const total = leftCount + rightCount
    if (total < 8) {
      profile.preferredStrafeDir = 'unpredictable'
      return
    }
    const ratio = leftCount / total
    if (ratio > 0.65) profile.preferredStrafeDir = 'left'
    else if (ratio < 0.35) profile.preferredStrafeDir = 'right'
    else profile.preferredStrafeDir = 'unpredictable'

    const lateralSamples = recent.filter((s) => s.strafeDir !== 'none')
    if (lateralSamples.length > 0) {
      const avgLateral =
        lateralSamples.reduce((a, s) => a + s.velocityMagnitude, 0) / lateralSamples.length
      profile.strafeSpeedAverage = ewma(profile.strafeSpeedAverage, avgLateral, 0.1)
    }
  }

  private recomputeVelocityStats(profile: EnemyProfile): void {
    const recent = profile.movementSamples.slice(-20)
    if (recent.length === 0) return
    const mags = recent.map((s) => s.velocityMagnitude)
    const mean = mags.reduce((a, b) => a + b, 0) / mags.length
    const variance = mags.reduce((a, b) => a + (b - mean) ** 2, 0) / mags.length
    profile.velocityMagnitudeAverage = ewma(profile.velocityMagnitudeAverage, mean, 0.12)
    profile.velocityMagnitudeVariance = ewma(
      profile.velocityMagnitudeVariance,
      Math.sqrt(variance),
      0.12,
    )
  }

  private recomputeJumpFrequency(profile: EnemyProfile): void {
    const recent = profile.movementSamples.slice(-40)
    if (recent.length === 0) return
    const jumpCount = recent.filter((s) => s.jumping).length
    profile.jumpFrequency = ewma(profile.jumpFrequency, jumpCount / recent.length, 0.1)
  }

  private recomputeSprintConsistency(profile: EnemyProfile): void {
    const recent = profile.movementSamples.slice(-30)
    if (recent.length === 0) return
    const sprintCount = recent.filter((s) => s.sprinting).length
    profile.sprintConsistency = ewma(profile.sprintConsistency, sprintCount / recent.length, 0.1)
  }

  private recomputeDirectionChangeRate(profile: EnemyProfile): void {
    const recent = profile.movementSamples.slice(-20)
    if (recent.length < 2) return
    let changes = 0
    for (let i = 1; i < recent.length; i++) {
      if (recent[i]?.strafeDir !== recent[i - 1]?.strafeDir) changes++
    }
    profile.directionChangeRate = ewma(profile.directionChangeRate, changes / recent.length, 0.1)
  }

  private recomputeMovementEntropy(profile: EnemyProfile): void {
    const recent = profile.movementSamples.slice(-20)
    const counts: Record<string, number> = { left: 0, right: 0, none: 0 }
    for (const s of recent) {
      counts[s.strafeDir] = (counts[s.strafeDir] ?? 0) + 1
    }
    const maxEntropy = Math.log2(3)
    const raw = shannonEntropy(counts)
    profile.movementPatternEntropy = maxEntropy > 0 ? raw / maxEntropy : 0
  }

  private recomputeBlockingRatio(profile: EnemyProfile): void {
    const recent = profile.attackSamples.slice(-20)
    if (recent.length === 0) return
    const blockCount = recent.filter((s) => s.wasBlocking).length
    profile.blockingRatio = blockCount / recent.length
    profile.shieldUsageFrequency = ewma(profile.shieldUsageFrequency, profile.blockingRatio, 0.1)
  }

  private recomputeReachStats(profile: EnemyProfile): void {
    const recent = profile.attackSamples.slice(-20)
    if (recent.length === 0) return
    const avg = recent.reduce((a, s) => a + s.reachDistance, 0) / recent.length
    profile.averageReachDistance = ewma(profile.averageReachDistance, avg, 0.1)
    profile.combatEngagementRange = ewma(profile.combatEngagementRange, avg + 0.3, 0.08)
    const dists = recent.map((s) => s.reachDistance)
    const mean = dists.reduce((a, b) => a + b, 0) / dists.length
    const variance = dists.reduce((a, b) => a + (b - mean) ** 2, 0) / dists.length
    profile.attackAngleVariance = ewma(profile.attackAngleVariance, Math.sqrt(variance), 0.1)
  }

  private recomputeHitFromAbove(profile: EnemyProfile): void {
    const recent = profile.attackSamples.slice(-20)
    if (recent.length === 0) return
    const fromAbove = recent.filter((s) => s.fromAbove).length
    profile.hitFromAboveFrequency = ewma(
      profile.hitFromAboveFrequency,
      fromAbove / recent.length,
      0.1,
    )
  }

  private recomputeCritRate(profile: EnemyProfile): void {
    const recent = profile.damageSamples.slice(-20)
    if (recent.length === 0) return
    const crits = recent.filter((s) => s.wasCrit).length
    profile.criticalHitRate = ewma(profile.criticalHitRate, crits / recent.length, 0.12)
  }

  private recomputeBurstDamage(profile: EnemyProfile): void {
    const recent = profile.damageSamples.slice(-10)
    if (recent.length < 2) return
    const firstSample = recent[0]
    const lastSample = recent[recent.length - 1]
    if (firstSample === undefined || lastSample === undefined) return
    const totalDamage = recent.reduce((a, s) => a + s.amount, 0)
    const tickSpan = lastSample.tick - firstSample.tick
    if (tickSpan > 0)
      profile.burstDamageRate = ewma(profile.burstDamageRate, totalDamage / tickSpan, 0.1)
  }

  private recomputeBehaviorRatios(profile: EnemyProfile): void {
    const recent = profile.behaviorSamples.slice(-40)
    if (recent.length === 0) return
    const total = recent.length
    profile.bowUsageRatio = ewma(
      profile.bowUsageRatio,
      recent.filter((s) => s.usedBow).length / total,
      0.1,
    )
    profile.pearlUsageRatio = ewma(
      profile.pearlUsageRatio,
      recent.filter((s) => s.usedPearl).length / total,
      0.1,
    )
    profile.potionUsageRatio = ewma(
      profile.potionUsageRatio,
      recent.filter((s) => s.usedPotion).length / total,
      0.1,
    )
    profile.gappleUsageRatio = ewma(
      profile.gappleUsageRatio,
      recent.filter((s) => s.usedGapple).length / total,
      0.1,
    )
    profile.axeUsageRatio = ewma(
      profile.axeUsageRatio,
      recent.filter((s) => s.usedAxe).length / total,
      0.1,
    )
    profile.crossbowUsageRatio = ewma(
      profile.crossbowUsageRatio,
      recent.filter((s) => s.usedBow && s.usedAxe).length / total,
      0.1,
    )
  }
}
