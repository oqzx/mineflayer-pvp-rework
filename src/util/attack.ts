import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'

export function performAttack(bot: Bot, target: Entity, swing = true): void {
  bot.attack(target)
  if (!swing) bot.swingArm(undefined)
}

export function swingArm(bot: Bot): void {
  bot.swingArm(undefined)
}
