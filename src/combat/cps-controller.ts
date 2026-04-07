import type { CpsConfig } from '../config/types.js'
import type { CombatPhase } from '../core/combat-state.js'
import { randomInRange } from '../util/humanizer.js'

export class CpsController {
  private lastAttackTick: number = 0
  private nextIntervalTicks: number = 0
  private rolledCps: number = 0

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

  forceReset(): void {
    this.lastAttackTick = 0
    this.nextIntervalTicks = 0
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
    const range = phase === 'combo' ? this.config.comboRange : this.config.engagingRange
    const cps = Math.min(this.config.max, randomInRange(range)) * fatigueMultiplier
    this.rolledCps = cps
    const baseTicks = 20 / Math.max(0.5, cps)
    this.nextIntervalTicks = Math.max(1, Math.round(baseTicks))
  }
}
