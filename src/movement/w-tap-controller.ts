import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import { movingAt } from '../calc/math.js'

const PI_OVER_3 = Math.PI / 3

export class WTapController {
  async wtap(bot: Bot): Promise<void> {
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
    await bot.waitForTicks(1)
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
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
