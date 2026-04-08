import { StateBehavior } from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { StateMachineData } from '@nxg-org/mineflayer-static-statemachine'
import type { PvpData } from '../pvp-data.js'

export class PearlingBehavior extends StateBehavior {
  static readonly stateName = 'Pearling'

  private done = false

  constructor(bot: Bot, data: StateMachineData) {
    super(bot, data)
  }

  onStateEntered(): void {
    this.done = false
    void this.executePearl()
  }

  update(): void {}

  isFinished(): boolean {
    return this.done
  }

  onStateExited(): void {
    this.done = false
  }

  private async executePearl(): Promise<void> {
    const d = this.data as PvpData

    if (d.pearl.shouldThrowDefensive(this.bot)) {
      const threats = d.targetSelector.getNearbyThreats(this.bot, d.config.generic.viewDistance)
      await d.pearl.throwDefensive(this.bot, threats)
    } else if (d.entity && d.pearl.shouldThrowAggressive(this.bot, d.entity)) {
      await d.pearl.throwAggressive(this.bot, d.entity)
    }

    this.done = true
  }
}
