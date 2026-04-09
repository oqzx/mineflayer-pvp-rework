import type { CpsConfig } from '../config/types.js'
import type { CombatPhase } from '../core/combat-state.js'
import { randomInRange } from '../util/humanizer.js'

export class CpsController {
  private lastAttackTick: number = 0
  private nextIntervalTicks: number = 0
  private rolledCps: number = 0
  private consecutiveHits: number = 0
  private burstModeActive: boolean = false
  private burstTicksLeft: number = 0

  constructor(private readonly config: CpsConfig) {
    this.rollNextInterval('engaging', 1)
  }

  shouldAttack(currentTick: number, phase: CombatPhase, fatigueMultiplier = 1): boolean {
    const elapsed = currentTick - this.lastAttackTick
    if (elapsed < this.nextIntervalTicks) return false

    this.lastAttackTick = currentTick
    this.rollNextInterval(phase, fatigueMultiplier)
    return true
  }

  recordHit(): void {
    this.consecutiveHits++
    if (this.consecutiveHits >= 3 && Math.random() < 0.45) {
      this.burstModeActive = true
      this.burstTicksLeft = Math.floor(Math.random() * 4) + 2
    }
  }

  resetHitStreak(): void {
    this.consecutiveHits = 0
    this.burstModeActive = false
    this.burstTicksLeft = 0
  }

  forceReset(): void {
    this.lastAttackTick = 0
    this.nextIntervalTicks = 0
    this.consecutiveHits = 0
    this.burstModeActive = false
    this.burstTicksLeft = 0
  }

  getDebugState(currentTick: number): {
    elapsedTicks: number
    nextIntervalTicks: number
    readyInTicks: number
    intendedCps: number
  } {
    const elapsedTicks = currentTick - this.lastAttackTick
    return {
      elapsedTicks,
      nextIntervalTicks: this.nextIntervalTicks,
      readyInTicks: Math.max(0, this.nextIntervalTicks - elapsedTicks),
      intendedCps: this.rolledCps,
    }
  }

  private rollNextInterval(phase: CombatPhase, fatigueMultiplier: number): void {
    if (this.burstModeActive && this.burstTicksLeft > 0) {
      this.burstTicksLeft--
      if (this.burstTicksLeft <= 0) this.burstModeActive = false
      const burstCps = this.config.max * fatigueMultiplier
      this.rolledCps = burstCps
      this.nextIntervalTicks = Math.max(1, Math.round(20 / Math.max(0.5, burstCps)))
      return
    }

    const inCombo = phase === 'combo' || phase === 'engaging'
    const range =
      inCombo && this.consecutiveHits >= 2 ? this.config.comboRange : this.config.engagingRange

    const cps = Math.min(this.config.max, randomInRange(range)) * fatigueMultiplier
    this.rolledCps = cps
    const baseTicks = 20 / Math.max(0.5, cps)
    this.nextIntervalTicks = Math.max(1, Math.round(baseTicks))
  }
}
