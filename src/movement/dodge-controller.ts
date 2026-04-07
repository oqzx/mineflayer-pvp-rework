import type { Bot, ControlState } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import type { DodgeConfig } from '../config/types.js'
import type { IncomingProjectile } from '../core/combat-state.js'
import { vectorMagnitude } from '../calc/math.js'
import { randomIntInRange, delay } from '../util/humanizer.js'

const FIREBALL_ENTITY_NAMES = ['fireball', 'small_fireball', 'wither_skull']
const ARROW_ENTITY_NAMES = ['arrow', 'spectral_arrow', 'trident']

export function classifyProjectile(entity: Entity): IncomingProjectile['type'] | null {
  const name = entity.name?.toLowerCase() ?? ''
  if (ARROW_ENTITY_NAMES.findIndex(p=>name.includes(p)) !== -1) return 'arrow'
  if (FIREBALL_ENTITY_NAMES.findIndex(p=>name.includes(p)) !== -1) return 'fireball'
  if (name === 'ender_peal') return 'pearl'
  return null
}

export function isHeadingToward(projectile: Entity, target: Entity, threshold = 1.5): boolean {
  // vel is always zero.
  const vel = projectile.velocity
  const speed = vectorMagnitude(vel)
  if (speed < 0.01) return false
  const dir = new Vec3(vel.x / speed, vel.y / speed, vel.z / speed)
  const toTarget = target.position.minus(projectile.position)
  const dot = dir.x * toTarget.x + dir.y * toTarget.y + dir.z * toTarget.z
  if (dot <= 0) return false
  const cross = new Vec3(
    dir.y * toTarget.z - dir.z * toTarget.y,
    dir.z * toTarget.x - dir.x * toTarget.z,
    dir.x * toTarget.y - dir.y * toTarget.x,
  )
  console.log(vectorMagnitude(cross))
  return vectorMagnitude(cross) < threshold
}

export function estimateImpactTick(projectile: Entity, target: Entity): number {
  const speed = vectorMagnitude(projectile.velocity)
  if (speed < 0.01) return 999
  const dist = projectile.position.distanceTo(target.position)
  return Math.round(dist / speed)
}

export function chooseDodgeDir(projectile: Entity, bot: Entity): ControlState {
  const vel = projectile.velocity
  const speed = vectorMagnitude(vel)
  if (speed < 0.01) return 'left'
  const dir = new Vec3(vel.x / speed, 0, vel.z / speed)
  const rightPerp = new Vec3(dir.z, 0, -dir.x)
  const toBot = bot.position.minus(projectile.position)
  const dot = toBot.x * rightPerp.x + toBot.z * rightPerp.z
  return dot >= 0 ? 'right' : 'left'
}

export class DodgeController {
  private dodging: boolean = false
  private deflecting: boolean = false

  constructor(private readonly config: DodgeConfig) {}

  async handleIncoming(bot: Bot, projectile: IncomingProjectile): Promise<void> {
    if (!this.config.enabled || this.dodging) return

    if (projectile.type === 'fireball') {
      const dist = bot.entity.position.distanceTo(projectile.entity.position)
      if (dist <= 4.5) {
        await this.deflectFireball(bot, projectile.entity)
        return
      }
    }

    await this.dodgeProjectile(bot, projectile.entity)
  }

  private async dodgeProjectile(bot: Bot, projectile: Entity): Promise<void> {
    this.dodging = true
    const delayTicks = randomIntInRange(this.config.reactionDelay)
    if (delayTicks > 0) await bot.waitForTicks(delayTicks)

    const dodgeDir = chooseDodgeDir(projectile, bot.entity)
    const opposite: ControlState = dodgeDir === 'left' ? 'right' : 'left'

    bot.setControlState(dodgeDir, true)
    bot.setControlState(opposite, false)
    await bot.waitForTicks(4)
    bot.setControlState(dodgeDir, false)
    this.dodging = false
  }

  private async deflectFireball(bot: Bot, fireball: Entity): Promise<void> {
    if (this.deflecting) return
    this.deflecting = true

    const center = fireball.position.offset(0, fireball.height / 2, 0)
    await bot.lookAt(center, true)

    for (let i = 0; i < 6; i++) {
      bot.attack(fireball)
      await delay(randomIntInRange({ min: 40, max: 80 }))
    }

    this.deflecting = false
  }
}
