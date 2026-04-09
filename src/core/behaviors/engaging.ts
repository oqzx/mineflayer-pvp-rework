import { StateBehavior } from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { StateMachineData } from '@nxg-org/mineflayer-static-statemachine'
import type { PvpData } from '../pvp-data.js'

export class EngagingBehavior extends StateBehavior {
  static readonly stateName = 'Engaging'

  constructor(bot: Bot, data: StateMachineData) {
    super(bot, data)
  }

  onStateEntered(): void {
    const d = this.data as PvpData
    if (!d.entity) return
    void d.sword.equipBestWeapon()
    void d.sword.engage(d.entity)
  }

  update(): void {
    const d = this.data as PvpData
    if (!d.entity) return
    if (!d.sword.target || d.sword.target.id !== d.entity.id) {
      void d.sword.engage(d.entity)
    }
  }

  isFinished(): boolean {
    return false
  }

  onStateExited(): void {}
}
