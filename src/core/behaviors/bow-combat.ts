import { StateBehavior } from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { StateMachineData } from '@nxg-org/mineflayer-static-statemachine'
import type { PvpData } from '../pvp-data.js'

export function canEnterBowCombat(data: PvpData): boolean {
  if (!data.config.bow.enabled) return false
  if (!data.entity) return false
  return data.projectile.canEngage()
}

export class BowCombatBehavior extends StateBehavior {
  static readonly stateName = 'BowCombat'

  constructor(bot: Bot, data: StateMachineData) {
    super(bot, data)
  }

  onStateEntered(): void {
    const d = this.data as PvpData
    if (!canEnterBowCombat(d)) return
    const target = d.entity
    if (!target) return
    void d.projectile.engage(target)
  }

  update(): void {
    const d = this.data as PvpData
    if (!canEnterBowCombat(d)) return
    const target = d.entity
    if (!target) return
    if (!d.projectile.isActive) {
      void d.projectile.engage(target)
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
