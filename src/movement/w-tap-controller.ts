import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import { movingAt } from '../calc/math.js'
import type { WTapConfig } from '../config/types.js'

const TICK_MS = 50
const PI_OVER_3 = Math.PI / 3

function msDelay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function randInRange(range: { min: number; max: number }): number {
  return range.min + Math.random() * (range.max - range.min)
}

export interface WTapContext {
  ticksSinceLastTargetHurt: number
  isFallingForCrit: boolean
}

export class WTapController {
  private busy = false
  private readonly config: WTapConfig

  constructor(config: WTapConfig) {
    this.config = config
  }

  isBusy(): boolean {
    return this.busy
  }

  shouldWTap(ctx: WTapContext): boolean {
    if (this.busy) return false
    if (ctx.isFallingForCrit) return false
    if (ctx.ticksSinceLastTargetHurt < this.config.iframeTicks) return false
    return true
  }

  async wtap(bot: Bot, ctx: WTapContext): Promise<void> {
    if (!this.shouldWTap(ctx)) return
    if (!bot.entity.onGround) return
    if (!bot.getControlState('sprint') && !bot.getControlState('forward')) return

    this.busy = true

    try {
      bot.setControlState('forward', false)
      bot.setControlState('sprint', false)

      const remainingIframeTicks = Math.max(
        0,
        this.config.iframeTicks - ctx.ticksSinceLastTargetHurt,
      )
      const iframeCoverMs = remainingIframeTicks * TICK_MS
      const releaseJitter = randInRange(this.config.releaseMsRange)
      const releaseMs = iframeCoverMs + releaseJitter

      await msDelay(releaseMs)

      if (!bot.entity) return

      const reMs = randInRange(this.config.reSprintMsRange)
      await msDelay(reMs)

      if (!bot.entity) return

      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
    } finally {
      this.busy = false
    }
  }

  async stap(bot: Bot, target: Entity, attackRange: number): Promise<void> {
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
    bot.setControlState('back', true)

    let attempts = 0
    while (attempts < 6) {
      const reach = bot.entity.position.distanceTo(target.position)
      const speed =
        (
          bot as unknown as { tracker?: { getEntitySpeed(e: Entity): Vec3 | null } }
        ).tracker?.getEntitySpeed(target) ?? new Vec3(0, 0, 0)

      const lookOk = movingAt(target.position, bot.entity.position, speed, PI_OVER_3)
      if (!lookOk || reach > attackRange + 0.2) break

      await bot.waitForTicks(1)
      attempts++
    }

    bot.setControlState('back', false)
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
  }
}
