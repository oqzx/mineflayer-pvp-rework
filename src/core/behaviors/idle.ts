import { StateBehavior } from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { StateMachineData } from '@nxg-org/mineflayer-static-statemachine'
import type { PvpData } from '../pvp-data.js'

export class IdleBehavior extends StateBehavior {
  static readonly stateName = 'Idle'

  constructor(bot: Bot, data: StateMachineData) {
    super(bot, data)
  }

  onStateEntered(): void {
    this.bot.clearControlStates()
  }

  update(): void {
    const d = this.data as PvpData
    if (d.entity) return
    if (!d.config.multiEnemy.assistTeammates) return
    const struggling = d.team.getStruggling()
    const first = struggling[0]
    if (first?.nearestEnemy) d.entity = first.nearestEnemy
  }

  isFinished(): boolean {
    return false
  }

  onStateExited(): void {}
}
