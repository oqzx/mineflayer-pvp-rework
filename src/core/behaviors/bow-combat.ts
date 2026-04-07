import { StateBehavior } from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { StateMachineData } from '@nxg-org/mineflayer-static-statemachine'
import type { PvpData } from '../pvp-data.js'

export class BowCombatBehavior extends StateBehavior {
  static readonly stateName = 'BowCombat'

  constructor(bot: Bot, data: StateMachineData) {
    super(bot, data)
  }

  onStateEntered(): void {
    const d = this.data as PvpData
    if (!d.entity) return
    void d.projectile.engage(d.entity)
  }

  update(): void {
    const d = this.data as PvpData
    if (!d.entity) return
    if (!d.projectile.isActive) {
      void d.projectile.engage(d.entity)
    }
  }

  isFinished(): boolean {
    return false
  }

  onStateExited(): void {
    const d = this.data as PvpData
    d.projectile.stop()
  }
}
