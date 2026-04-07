import type { Bot } from 'mineflayer'
import type { BlockHitConfig, LowHealthConfig } from '../config/types.js'
import { humanDelay, randomInRange } from '../util/humanizer.js'

export class BlockHitHandler {
  private active: boolean = false

  constructor(
    private readonly config: BlockHitConfig,
    private readonly lowHealth: LowHealthConfig,
  ) {}

  get isActive(): boolean {
    return this.active
  }

  async execute(bot: Bot, hasOffHand: boolean, isLowHealth: boolean): Promise<void> {
    if (!this.config.enabled || this.active) return

    const holdMs = isLowHealth
      ? randomInRange(this.lowHealth.blockHoldDuration)
      : randomInRange(this.config.holdDuration)

    const postMs = randomInRange(this.config.postDuration)

    this.active = true

    if (hasOffHand) {
      bot.activateItem(true)
    } else {
      bot.activateItem(false)
    }

    await humanDelay({ min: holdMs, max: holdMs })
    bot.deactivateItem()

    await humanDelay({ min: postMs, max: postMs })
    this.active = false
  }

  async executeExtended(bot: Bot): Promise<void> {
    if (!this.lowHealth.extendedBlockEnabled || this.active) return
    this.active = true
    bot.activateItem(true)
    await humanDelay(this.lowHealth.blockHoldDuration)
    bot.deactivateItem()
    this.active = false
  }
}
