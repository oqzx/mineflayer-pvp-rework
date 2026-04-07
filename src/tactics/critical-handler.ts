import type { Bot } from 'mineflayer'
import type { CriticalConfig } from '../config/types.js'

export class CriticalHandler {
  private awaitingCrit: boolean = false

  constructor(private readonly config: CriticalConfig) {}

  shouldAttemptCrit(
    ticksToNextAttack: number,
    botOnGround: boolean,
    inRange: boolean,
    inWater: boolean,
  ): boolean {
    if (!this.config.enabled || inWater) return false
    if (!inRange) return false

    switch (this.config.mode) {
      case 'hop':
        return ticksToNextAttack <= 8 && ticksToNextAttack >= -1
      case 'shorthop':
        return ticksToNextAttack === 1 && botOnGround
      default:
        return false
    }
  }

  async executeCrit(bot: Bot, ticksToNextAttack: number): Promise<void> {
    if (this.awaitingCrit) return

    switch (this.config.mode) {
      case 'hop':
        this.hop(bot, ticksToNextAttack)
        break
      case 'shorthop':
        await this.shorthop(bot)
        break
    }
  }

  async reactionCrit(bot: Bot, ticksToNextAttack: number): Promise<boolean> {
    if (!this.config.reactionEnabled || this.awaitingCrit) return false
    this.awaitingCrit = true

    for (let i = 0; i < 12; i++) {
      await bot.waitForTicks(1)
      if (bot.entity.onGround) {
        this.awaitingCrit = false
        return false
      }
      const preempt = this.config.maxPreemptiveTicks
      const falling = bot.entity.velocity.y <= -0.25
      const ready = ticksToNextAttack <= -1 + preempt
      if (falling && ready) break
      if (ticksToNextAttack <= -1 - this.config.maxWaitTicks) break
    }

    bot.setControlState('sprint', false)
    this.awaitingCrit = false
    return true
  }

  private hop(bot: Bot, ticksToNextAttack: number): void {
    if (ticksToNextAttack === 8 || !bot.entity.onGround) return
    bot.setControlState('jump', true)
    bot.setControlState('jump', false)
  }

  private async shorthop(bot: Bot): Promise<void> {
    this.awaitingCrit = true
    bot.entity.position = bot.entity.position.offset(0, 0.25, 0)
    bot.entity.onGround = false
    await bot.waitForTicks(2)
    const { x, z } = bot.entity.position
    bot.entity.position = bot.entity.position.set(x, Math.floor(bot.entity.position.y), z)
    this.awaitingCrit = false
  }
}
