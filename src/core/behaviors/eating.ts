import { StateBehavior } from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { StateMachineData } from '@nxg-org/mineflayer-static-statemachine'
import { Results } from '@nxg-org/mineflayer-auto-buff'
import type { PvpData } from '../pvp-data.js'

export class EatingBehavior extends StateBehavior {
  static readonly stateName = 'Eating'
  private static readonly INSTANT_HEALTH_GROUND_WAIT_TICKS = 12

  private done = false
  private healRunId = 0

  constructor(bot: Bot, data: StateMachineData) {
    super(bot, data)
  }

  onStateEntered(): void {
    this.done = false
    const runId = ++this.healRunId
    void this.heal(runId)
  }

  update(): void {}

  isFinished(): boolean {
    return this.done
  }

  onStateExited(): void {
    this.healRunId++
    this.done = false
  }

  private async heal(runId: number): Promise<void> {
    const d = this.data as PvpData
    if (d.sword.target != null) d.sword.stop()
    if (d.projectile.isActive()) await d.projectile.stop()
    if (!this.isActiveRun(runId)) return
    this.bot.clearControlStates()

    const result = await this.tryInstantHealth(d, runId)
    if (!this.isActiveRun(runId)) return
    console.log(`Tried to apply instant health buff, result: ${result}, ${d.autoBuff.hasItemForBuff('instanthealth') ? 'has item' : 'no item'}, ${d.autoBuff.hasBuff('instanthealth') ? 'already buffed' : 'not buffed'}`)
    if (
      result !== Results.SUCCESS &&
      result !== Results.ALREADY_BUFFED &&
      !d.health.isWaitingForInstantHealth() &&
      this.isActiveRun(runId)
    ) {
      await d.gap.eat(this.bot, d.entity)
    }
    if (!this.isActiveRun(runId)) return
    this.done = true
  }

  private async tryInstantHealth(d: PvpData, runId: number): Promise<Results> {
    if (!d.health.canAttemptInstantHealth()) return Results.FAIL
    if (d.autoBuff.hasBuff('instanthealth')) return Results.ALREADY_BUFFED
    if (!d.autoBuff.hasItemForBuff('instanthealth')) return Results.FAIL
    if (!this.isActiveRun(runId)) return Results.FAIL
    d.health.markInstantHealthAttempt()
    return await d.autoBuff.applyEffectsToSelf('instanthealth')
  }



  private isActiveRun(runId: number): boolean {
    return this.healRunId === runId
  }
}