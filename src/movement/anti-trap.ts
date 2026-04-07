import type { Bot, ControlState } from 'mineflayer'
import { Vec3 } from 'vec3'
import { holdJumpForNextTick } from '../util/jump-control.js'

export type AntiTrapConfig = {
  enabled: boolean
  detectionTicks: number
}

export class AntiTrap {
  private previousPos: Vec3 = new Vec3(0, 0, 0)
  private consecutiveTicks: number = 0

  constructor(private readonly config: AntiTrapConfig) {}

  update(bot: Bot, currentStrafeDir: ControlState | undefined): ControlState | undefined {
    if (!this.config.enabled) return currentStrafeDir

    const pos = bot.entity.position
    const delta = pos.minus(this.previousPos)
    const xzMove = Math.sqrt(delta.x * delta.x + delta.z * delta.z)
    const movingIntended = bot.getControlState('forward') || bot.getControlState('sprint')

    if (movingIntended && bot.entity.onGround && xzMove < 0.04) {
      this.consecutiveTicks++
    } else {
      this.consecutiveTicks = 0
    }

    this.previousPos = pos.clone()

    if (this.consecutiveTicks >= this.config.detectionTicks) {
      this.consecutiveTicks = 0
      bot.setControlState('forward', false)
      bot.setControlState('sprint', false)

      const escapeDir: ControlState = currentStrafeDir === 'left' ? 'right' : 'left'
      const opposite: ControlState = escapeDir === 'left' ? 'right' : 'left'
      bot.setControlState(escapeDir, true)
      bot.setControlState(opposite, false)
      holdJumpForNextTick(bot)
      return escapeDir
    }

    return currentStrafeDir
  }

  reset(): void {
    this.consecutiveTicks = 0
  }
}
