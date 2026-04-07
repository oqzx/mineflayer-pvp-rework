import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { MultiEnemyConfig } from '../config/types.js'
import { rankThreats } from './threat-assessor.js'
import { randomInRange } from '../util/humanizer.js'

const SWITCH_DELAY_TICKS = 10

export class TargetSelector {
  private switchCooldown: number = 0

  constructor(private readonly config: MultiEnemyConfig) {}

  tick(): void {
    if (this.switchCooldown > 0) this.switchCooldown--
  }

  selectPrimary(
    bot: Bot,
    currentTarget: Entity | undefined,
    candidates: Entity[],
    teammates: string[],
  ): Entity | undefined {
    if (!this.config.enabled || candidates.length === 0) return currentTarget

    const filtered = candidates.filter(
      (e) => !teammates.includes(e.username ?? '') && !teammates.includes(e.name ?? ''),
    )
    if (filtered.length === 0) return undefined

    const ranked = rankThreats(bot, filtered)
    const best = ranked[0]
    if (!best) return currentTarget

    if (!currentTarget) return best.entity

    if (this.switchCooldown > 0) return currentTarget

    const currentScore = ranked.find((r) => r.entity.id === currentTarget.id)
    if (!currentScore || best.score - currentScore.score > 0.25) {
      this.switchCooldown = SWITCH_DELAY_TICKS + Math.round(randomInRange({ min: 0, max: 8 }))
      return best.entity
    }

    return currentTarget
  }

  getNearbyThreats(bot: Bot, viewDistance: number): Entity[] {
    return Object.values(bot.entities).filter((e) => {
      if (!e || e === bot.entity) return false
      if (e.type !== 'player' && e.type !== 'hostile') return false
      return bot.entity.position.distanceTo(e.position) <= viewDistance
    })
  }
}
