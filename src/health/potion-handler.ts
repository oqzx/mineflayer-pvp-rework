import type { Bot } from 'mineflayer';
import type { Item } from 'prismarine-item';
import type { JumpBoostConfig } from '../config/types.js';

export type PotionSituation = 'height-advantage' | 'escape' | 'tower' | 'general';

export class PotionHandler {
  private consuming: boolean = false;

  constructor(private readonly config: JumpBoostConfig) {}

  get isBusy(): boolean {
    return this.consuming;
  }

  hasJumpBoostActive(bot: Bot): boolean {
    return bot.entity.effects[8] !== undefined;
  }

  findJumpBoostPotion(bot: Bot): Item | undefined {
    return bot.inventory.items().find((i) => {
      if (i.name !== 'potion') return false;
      const nbt = i.nbt as unknown as { value?: { Potion?: { value?: string } } } | null;
      return nbt?.value?.Potion?.value?.includes('leaping') === true;
    });
  }

  shouldDrink(bot: Bot, situation: PotionSituation): boolean {
    if (!this.config.enabled || this.consuming) return false;
    if (this.hasJumpBoostActive(bot)) return false;
    if (!this.findJumpBoostPotion(bot)) return false;

    switch (situation) {
      case 'height-advantage':
        return this.config.useForHeightAdvantage;
      case 'escape':
        return this.config.useForEscape;
      case 'tower':
        return this.config.useForTowering;
      default:
        return false;
    }
  }

  async drinkJumpBoost(bot: Bot): Promise<boolean> {
    const potion = this.findJumpBoostPotion(bot);
    if (!potion || this.consuming) return false;
    this.consuming = true;
    try {
      await bot.util.inv.customEquip(potion, 'hand');
      bot.activateItem(false);
      await bot.waitForTicks(32);
      return true;
    } finally {
      this.consuming = false;
    }
  }
}
