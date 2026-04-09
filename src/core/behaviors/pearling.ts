import { StateBehavior } from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { StateMachineData } from '@nxg-org/mineflayer-static-statemachine'
import type { PvpData } from '../pvp-data.js'

export class PearlingBehavior extends StateBehavior {
  static readonly stateName = 'Pearling'

  private done = false
  private enteredTick: number | null = null
  private executeStartedTick: number | null = null

  constructor(bot: Bot, data: StateMachineData) {
    super(bot, data)
  }

  onStateEntered(): void {
    this.done = false
    const d = this.data as PvpData
    this.enteredTick = d.tick
    console.log(`[pearling-state] enter tick=${d.tick} target=${d.entity?.id ?? 'none'}`)
    void this.executePearl()
  }

  update(): void {}

  isFinished(): boolean {
    return this.done
  }

  onStateExited(): void {
    const d = this.data as PvpData
    const stateTicks = this.enteredTick === null ? 0 : d.tick - this.enteredTick
    console.log(`[pearling-state] exit tick=${d.tick} stateTicks=${stateTicks} target=${d.entity?.id ?? 'none'}`)
    this.done = false
    this.enteredTick = null
    this.executeStartedTick = null
  }

  private async executePearl(): Promise<void> {
    const d = this.data as PvpData

    this.executeStartedTick = d.tick
    console.log(`[pearling-state] execute start tick=${d.tick} target=${d.entity?.id ?? 'none'}`)
    if (d.pearl.shouldThrowDefensive(this.bot)) {
      const threats = d.targetSelector.getNearbyThreats(this.bot, d.config.generic.viewDistance)
      await d.pearl.throwDefensive(this.bot, threats)
    } else if (
      d.health.isLow &&
      !d.health.isWaitingForInstantHealth() &&
      d.entity &&
      d.pearl.shouldThrowEscape(this.bot, d.entity)
    ) {
      await d.pearl.throwEscape(this.bot, d.entity)
    }
    else if (d.entity && d.pearl.shouldThrowAggressive(this.bot, d.entity)) {
      await d.pearl.throwAggressive(this.bot, d.entity)
    }

    const executeTicks = this.executeStartedTick === null ? 0 : d.tick - this.executeStartedTick
    console.log(`[pearling-state] execute end tick=${d.tick} executeTicks=${executeTicks} target=${d.entity?.id ?? 'none'}`)
    this.done = true
  }
}
