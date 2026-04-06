import type { Bot } from 'mineflayer';
import type { Item } from 'prismarine-item';
import type { GapConfig } from '../config/types.js';
import type { CombatPhase } from '../core/combat-state.js';

export class GapHandler {
  private eating: boolean = false;

  constructor(private readonly config: GapConfig) {}

  get isEating(): boolean {
    return this.eating;
  }

  findGoldenApple(bot: Bot): Item | undefined {
    return (
      bot.inventory.items().find((i) => i.name === 'golden_apple') ??
      bot.inventory.items().find((i) => i.name === 'enchanted_golden_apple')
    );
  }

  shouldEat(bot: Bot, phase: CombatPhase, _incomingThreat: boolean): boolean {
    if (!this.config.enabled || this.eating) return false;
    if ((bot.health ?? 20) > this.config.healthThreshold) return false;
    if (!this.findGoldenApple(bot)) return false;

    const safePhasesToEat: CombatPhase[] = ['backing-off', 'retreating', 'idle'];
    const canEatDuringCombat = this.config.eatDuringCombat && phase !== 'bow-combat' && phase !== 'dodging';

    return safePhasesToEat.includes(phase) || canEatDuringCombat;
  }

  async eat(bot: Bot): Promise<boolean> {
    const apple = this.findGoldenApple(bot);
    if (!apple || this.eating) return false;

    this.eating = true;
    try {
      await bot.util.inv.customEquip(apple, 'hand');
      if (this.config.shieldWhileEating) bot.activateItem(true);
      bot.activateItem(false);
      await bot.waitForTicks(32);
      bot.deactivateItem();
      if (this.config.shieldWhileEating) bot.deactivateItem();
      return true;
    } finally {
      this.eating = false;
    }
  }
}
