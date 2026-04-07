import type { EnemyProfile } from './session-memory.js'
import type { AdaptationConfig } from '../config/types.js'

export type CombatStrategy = {
  beAggressive: boolean
  disableShield: boolean
  counterStrafeDir: 'left' | 'right' | 'none'
  delayAttacksForCooldown: boolean
  prioritiseKb: boolean
  avoidComboGaps: boolean
  targetExposedSide: boolean
  preferRangedOpening: boolean
  counterBowSpam: boolean
  punishBlockDrops: boolean
  exploitPredictability: boolean
  maintainPressure: boolean
  feintEnabled: boolean
  patienceRequired: boolean
  useHeightAdvantage: boolean
  aggressionLevel: number
  strafingIntensity: number
  retreatThreshold: number
}

const defaultStrategy: CombatStrategy = {
  beAggressive: true,
  disableShield: true,
  counterStrafeDir: 'none',
  delayAttacksForCooldown: false,
  prioritiseKb: false,
  avoidComboGaps: false,
  targetExposedSide: false,
  preferRangedOpening: false,
  counterBowSpam: false,
  punishBlockDrops: false,
  exploitPredictability: false,
  maintainPressure: true,
  feintEnabled: false,
  patienceRequired: false,
  useHeightAdvantage: true,
  aggressionLevel: 0.6,
  strafingIntensity: 0.6,
  retreatThreshold: 0.2,
}

export class StyleAdapter {
  constructor(private readonly config: AdaptationConfig) {}

  deriveStrategy(profile: EnemyProfile): CombatStrategy {
    if (!this.config.enabled || profile.totalObservations < this.config.minDataPoints) {
      return { ...defaultStrategy }
    }

    const strategy: CombatStrategy = { ...defaultStrategy }

    if (profile.blockingRatio > 0.5) {
      strategy.disableShield = true
      strategy.punishBlockDrops = true
      strategy.beAggressive = false
      strategy.patienceRequired = true
    }

    if (profile.averageCps > 12) {
      strategy.beAggressive = false
      strategy.prioritiseKb = true
      strategy.avoidComboGaps = true
      strategy.strafingIntensity = 0.8
    }

    if (profile.averageCps < 6) {
      strategy.beAggressive = true
      strategy.delayAttacksForCooldown = false
      strategy.maintainPressure = true
    }

    if (profile.preferredStrafeDir === 'left') strategy.counterStrafeDir = 'right'
    else if (profile.preferredStrafeDir === 'right') strategy.counterStrafeDir = 'left'

    if (profile.bowUsageRatio > 0.3) {
      strategy.counterBowSpam = true
      strategy.preferRangedOpening = false
      strategy.strafingIntensity = 0.9
    }

    if (profile.predictabilityScore < 0.3) {
      strategy.exploitPredictability = true
    }

    if (profile.hitFromAboveFrequency > 0.4) {
      strategy.useHeightAdvantage = true
    }

    if (profile.aggressionScore > 0.75) {
      strategy.feintEnabled = true
      strategy.counterStrafeDir = profile.preferredStrafeDir === 'left' ? 'right' : 'left'
    }

    if (profile.comboHeaviness > 0.7) {
      strategy.avoidComboGaps = true
      strategy.patienceRequired = true
      strategy.prioritiseKb = true
    }

    if (profile.criticalHitRate > 0.35) {
      strategy.strafingIntensity = Math.min(1, strategy.strafingIntensity + 0.2)
      strategy.useHeightAdvantage = true
    }

    if (profile.axeUsageRatio > 0.3) {
      strategy.disableShield = false
      strategy.patienceRequired = true
    }

    if (profile.velocityMagnitudeAverage > 0.3) {
      strategy.targetExposedSide = true
    }

    const rawAggression =
      profile.aggressionScore * 0.4 +
      (1 - profile.blockingRatio) * 0.2 +
      (profile.averageCps / 20) * 0.2 +
      profile.sprintConsistency * 0.2
    strategy.aggressionLevel = Math.min(1, Math.max(0, rawAggression))

    strategy.retreatThreshold = Math.min(
      0.5,
      0.15 + profile.criticalHitRate * 0.2 + profile.burstDamageRate * 0.05,
    )

    return strategy
  }
}
