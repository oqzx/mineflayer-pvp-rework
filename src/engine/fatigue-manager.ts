import type { FatigueConfig } from '../config/types.js';

export type FatigueState = 'fresh' | 'fatigued' | 'recovering';

export type FatigueModifiers = {
  cpsMultiplier: number;
  strafeFrequencyMultiplier: number;
  state: FatigueState;
  fatigueFraction: number;
};

export class FatigueManager {
  private combatActiveTicks = 0;
  private recoveryTicksLeft = 0;
  private state: FatigueState = 'fresh';
  private fatigueFraction = 0;

  constructor(private readonly config: FatigueConfig) {}

  update(inCombat: boolean): FatigueModifiers {
    if (!this.config.enabled) {
      return this.freshModifiers();
    }

    if (this.state === 'recovering') {
      this.recoveryTicksLeft--;
      if (this.recoveryTicksLeft <= 0) {
        this.state = 'fresh';
        this.combatActiveTicks = 0;
        this.fatigueFraction = 0;
      } else {
        const progress = 1 - this.recoveryTicksLeft / this.config.recoveryTicks;
        this.fatigueFraction = Math.max(0, 1 - progress);
      }
      return this.buildModifiers();
    }

    if (!inCombat) {
      if (this.combatActiveTicks > 0) {
        this.combatActiveTicks = Math.max(0, this.combatActiveTicks - 3);
      }
      if (this.state === 'fatigued') {
        this.state = 'recovering';
        this.recoveryTicksLeft = this.config.recoveryTicks;
      }
      return this.freshModifiers();
    }

    this.combatActiveTicks++;

    if (this.state === 'fresh' && this.combatActiveTicks >= this.config.onsetTicks) {
      this.state = 'fatigued';
    }

    if (this.state === 'fatigued') {
      const excess = this.combatActiveTicks - this.config.onsetTicks;
      this.fatigueFraction = Math.min(1, excess / (this.config.onsetTicks * 0.5));

      if (excess > this.config.onsetTicks * 0.8) {
        this.state = 'recovering';
        this.recoveryTicksLeft = this.config.recoveryTicks;
        this.combatActiveTicks = 0;
      }
    }

    return this.buildModifiers();
  }

  reset(): void {
    this.combatActiveTicks = 0;
    this.recoveryTicksLeft = 0;
    this.state = 'fresh';
    this.fatigueFraction = 0;
  }

  get isFatigued(): boolean {
    return this.state === 'fatigued';
  }

  get isRecovering(): boolean {
    return this.state === 'recovering';
  }

  private buildModifiers(): FatigueModifiers {
    const f = this.fatigueFraction;
    const cpsMultiplier = 1 - f * (1 - this.config.cpsPenaltyFactor);
    const strafeMultiplier = 1 - f * (1 - this.config.strafeFrequencyPenaltyFactor);
    return {
      cpsMultiplier,
      strafeFrequencyMultiplier: strafeMultiplier,
      state: this.state,
      fatigueFraction: f,
    };
  }

  private freshModifiers(): FatigueModifiers {
    return {
      cpsMultiplier: 1,
      strafeFrequencyMultiplier: 1,
      state: 'fresh',
      fatigueFraction: 0,
    };
  }
}
