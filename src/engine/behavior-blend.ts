import type { DecisionFrame } from './decision-engine.js'
import type { BehaviorBlendConfig } from '../config/types.js'
import type { CombatSnapshot } from '../core/combat-state.js'

export type BlendWeights = {
  strafeWeight: number
  attackWeight: number
  retreatWeight: number
  blockWeight: number
  critWeight: number
  wTapWeight: number
  trackWeight: number
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export class BehaviorBlend {
  private currentWeights: BlendWeights

  constructor(private readonly config: BehaviorBlendConfig) {
    this.currentWeights = this.buildDefault()
  }

  compute(frame: DecisionFrame, snapshot: CombatSnapshot, fatigueModifier: number): BlendWeights {
    if (!this.config.enabled) {
      return this.buildDefault()
    }

    const alpha = this.config.smoothingFactor
    const { scores } = frame

    const strafeRaw = Math.max(scores.strafeLeft, scores.strafeRight) * this.config.strafeBaseWeight
    const attackRaw = scores.attack * this.config.hitSelectBaseWeight
    const retreatRaw = scores.retreat * this.config.retreatBaseWeight
    const blockRaw = scores.block
    const critRaw = scores.criticalSetup
    const wTapRaw = scores.wTap
    const trackRaw = scores.track

    const incomingPressure = snapshot.incomingProjectiles.length > 0 ? 0.4 : 0
    const comboBoost = snapshot.comboActive ? 0.15 : 0
    const retreatBoost = retreatRaw > 0.5 ? 0.25 : 0

    const target: BlendWeights = {
      strafeWeight: clamp(
        strafeRaw * (1 - retreatBoost) * fatigueModifier + comboBoost * 0.1,
        0,
        1,
      ),
      attackWeight: clamp(attackRaw * fatigueModifier + comboBoost * 0.2, 0, 1),
      retreatWeight: clamp(retreatRaw + incomingPressure * 0.5, 0, 1),
      blockWeight: clamp(blockRaw + incomingPressure * 0.3, 0, 1),
      critWeight: clamp(critRaw * (snapshot.inRange ? 1 : 0.1), 0, 1),
      wTapWeight: clamp(wTapRaw * (snapshot.comboActive ? 1 : 0.5), 0, 1),
      trackWeight: clamp(trackRaw, 0, 1),
    }

    const smoothed: BlendWeights = {
      strafeWeight: lerp(this.currentWeights.strafeWeight, target.strafeWeight, alpha),
      attackWeight: lerp(this.currentWeights.attackWeight, target.attackWeight, alpha),
      retreatWeight: lerp(this.currentWeights.retreatWeight, target.retreatWeight, alpha),
      blockWeight: lerp(this.currentWeights.blockWeight, target.blockWeight, alpha),
      critWeight: lerp(this.currentWeights.critWeight, target.critWeight, alpha),
      wTapWeight: lerp(this.currentWeights.wTapWeight, target.wTapWeight, alpha),
      trackWeight: lerp(this.currentWeights.trackWeight, target.trackWeight, alpha),
    }

    this.currentWeights = smoothed
    return smoothed
  }

  reset(): void {
    this.currentWeights = this.buildDefault()
  }

  private buildDefault(): BlendWeights {
    return {
      strafeWeight: this.config.strafeBaseWeight,
      attackWeight: this.config.hitSelectBaseWeight,
      retreatWeight: this.config.retreatBaseWeight,
      blockWeight: 0.2,
      critWeight: 0.4,
      wTapWeight: 0.3,
      trackWeight: 0.85,
    }
  }
}
