import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import type { Entity } from 'prismarine-entity'
import type { GapConfig } from '../config/types.js'
import type { CombatPhase } from '../index.js'
import { goals } from 'mineflayer-pathfinder'
import 'mineflayer-pathfinder'
import { FollowGoal } from '../util/follow-goal.js'

type BotWithPathfinder = Bot & {
  pathfinder?: {
    goal: goals.Goal | null
    setGoal(goal: goals.Goal | null, dynamic?: boolean): void
    isMoving(): boolean
    stop(): void
  }
}

export class GapHandler {
  private eating: boolean = false
  private retreatGoal: goals.Goal | undefined
  private retreatGoalTargetId: Entity['id'] | undefined

  constructor(private readonly config: GapConfig) {}

  get isEating(): boolean {
    return this.eating
  }

  findGoldenApple(bot: Bot): Item | undefined {
    return (
      bot.inventory.items().find((i) => i.name === 'golden_apple') ??
      bot.inventory.items().find((i) => i.name === 'enchanted_golden_apple')
    )
  }

  shouldEat(bot: Bot, _phase: CombatPhase, _incomingThreat: boolean): boolean {
    if (!this.config.enabled || this.eating) return false
    if ((bot.health ?? 20) > this.config.healthThreshold) return false
    if (!this.findGoldenApple(bot)) return false
    return true
  }

  async eat(bot: Bot, target?: Entity): Promise<boolean> {
    const apple = this.findGoldenApple(bot)
    if (!apple || this.eating) return false

    this.eating = true
    try {
      this.startRetreatGoal(bot, target)
      await bot.util.inv.customEquip(apple, 'hand')
      if (this.config.shieldWhileEating) bot.activateItem(true)
      bot.activateItem(false)
      await bot.waitForTicks(32)
      bot.deactivateItem()
      if (this.config.shieldWhileEating) bot.deactivateItem()
      await this.reequipWeapon(bot)
      return true
    } finally {
      this.stopRetreatGoal(bot)
      this.eating = false
    }
  }

  private startRetreatGoal(bot: Bot, target?: Entity): void {
    if (!target) return
    const pathfinder = (bot as BotWithPathfinder).pathfinder
    if (!pathfinder) return

    const isSameTargetGoal = this.retreatGoalTargetId === target.id
    if (!this.retreatGoal || !isSameTargetGoal) {
      this.stopRetreatGoal(bot)
      this.retreatGoal = new goals.GoalInvert(new FollowGoal(bot, target, 25, 5))
      this.retreatGoalTargetId = target.id
    }

    if (pathfinder.goal !== this.retreatGoal) {
      pathfinder.setGoal(this.retreatGoal, true)
    }
  }

  private stopRetreatGoal(bot: Bot): void {
    const pathfinder = (bot as BotWithPathfinder).pathfinder
    if (!pathfinder) return

    if (pathfinder.goal && this.retreatGoal && pathfinder.goal === this.retreatGoal) {
      pathfinder.setGoal(null)
    } else if (this.retreatGoal && pathfinder.isMoving()) {
      pathfinder.stop()
    }

    this.retreatGoal = undefined
    this.retreatGoalTargetId = undefined
  }

  private async reequipWeapon(bot: Bot): Promise<void> {
    const weapon =
      bot.util.inv.getAllItems().find((item) => item.name.includes('sword')) ??
      bot.util.inv.getAllItems().find((item) => item.name.includes('axe'))

    if (weapon) {
      await bot.util.inv.customEquip(weapon, 'hand')
    }
  }
}
