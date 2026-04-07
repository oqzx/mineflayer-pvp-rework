import { StateBehavior } from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { StateMachineData } from '@nxg-org/mineflayer-static-statemachine'
import type { PvpData } from '../pvp-data.js'

export class DodgeBehavior extends StateBehavior {
  static readonly stateName = 'Dodging'

  constructor(bot: Bot, data: StateMachineData) {
    super(bot, data)
  }

  onStateEntered(): void {
    const d = this.data as PvpData
    const proj = d.incomingProjectiles[0]
    if (proj) void d.dodge.handleIncoming(this.bot, proj)
  }

  update(): void {}

  isFinished(): boolean {
    return false
  }

  onStateExited(): void {}
}
