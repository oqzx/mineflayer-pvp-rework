import { StateBehavior } from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { StateMachineData } from '@nxg-org/mineflayer-static-statemachine'
import { Results } from '@nxg-org/mineflayer-auto-buff'
import type { PvpData } from '../pvp-data.js'

export class EatingBehavior extends StateBehavior {
  static readonly stateName = 'Eating'

  private done = false

  constructor(bot: Bot, data: StateMachineData) {
    super(bot, data)
  }

  onStateEntered(): void {
    this.done = false
    void this.heal()
  }

  update(): void {}

  isFinished(): boolean {
    return this.done
  }

  onStateExited(): void {
    this.done = false
  }

  private async heal(): Promise<void> {
    const d = this.data as PvpData
    if (d.sword.target != null) d.sword.stop()
    if (d.projectile.isActive()) await d.projectile.stop()
    this.bot.clearControlStates()

    const result = await this.tryInstantHealth(d)
    // console.log(`Tried to apply instant health buff, result: ${result}, ${d.autoBuff.hasItemForBuff('instanthealth') ? 'has item' : 'no item'}, ${d.autoBuff.hasBuff('instanthealth') ? 'already buffed' : 'not buffed'}`)
    if (
      result !== Results.SUCCESS &&
      result !== Results.ALREADY_BUFFED &&
      !d.health.isWaitingForInstantHealth()
    ) {
      await d.gap.eat(this.bot, d.entity)
    }
    this.done = true
  }

  private async tryInstantHealth(d: PvpData): Promise<Results> {
    if (!d.health.canAttemptInstantHealth()) return Results.FAIL
    if (d.autoBuff.hasBuff('instanthealth')) return Results.ALREADY_BUFFED
    if (!d.autoBuff.hasItemForBuff('instanthealth')) return Results.FAIL
    d.health.markInstantHealthAttempt()
    return await d.autoBuff.applyEffectsToSelf('instanthealth')
  }
}
