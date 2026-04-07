import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';

const JUMP_THRESHOLD = 0.4;
const JUMP_BOOST_THRESHOLD = 1.2;

type BotWithRegistry = Bot & {
  registry?: { effectsByName?: Record<string, { id: number }> };
};

function resolveJumpBoostEffectId(bot: Bot): number {
  const registry = (bot as BotWithRegistry).registry;
  return (
    registry?.effectsByName?.['jump_boost']?.id ??
    registry?.effectsByName?.['Jump Boost']?.id ??
    8
  );
}

export class HeightAdvantage {
  seek(bot: Bot, target: Entity, enabled: boolean): void {
    if (!enabled || !bot.entity.onGround) return;
    const diff = bot.entity.position.y - target.position.y;
    if (diff >= JUMP_THRESHOLD) return;
    bot.setControlState('jump', true);
    bot.setControlState('jump', false);
  }

  hasJumpBoost(bot: Bot): boolean {
    const id = resolveJumpBoostEffectId(bot);
    return bot.entity.effects[id] !== undefined;
  }

  getJumpBoostLevel(bot: Bot): number {
    const id = resolveJumpBoostEffectId(bot);
    return (bot.entity.effects[id]?.amplifier ?? -1) + 1;
  }

  shouldUseJumpBoostPotion(bot: Bot, _situation: 'height' | 'escape' | 'tower'): boolean {
    if (this.hasJumpBoost(bot)) return false;
    const potion = bot.inventory.items().find((i) => i.name.includes('jump_boost') || i.name.includes('leaping'));
    return potion !== undefined;
  }

  async drinkJumpBoost(bot: Bot): Promise<boolean> {
    const potion = bot.inventory.items().find((i) => i.name.includes('jump_boost') || i.name.includes('leaping'));
    if (!potion) return false;
    await bot.util.inv.customEquip(potion, 'hand');
    bot.activateItem(false);
    await bot.waitForTicks(32);
    return true;
  }

  seekWithJumpBoost(bot: Bot, target: Entity, enabled: boolean, jumpBoostEnabled: boolean): void {
    if (!enabled) return;
    const diff = bot.entity.position.y - target.position.y;

    if (diff < -JUMP_BOOST_THRESHOLD && jumpBoostEnabled && this.hasJumpBoost(bot)) {
      if (bot.entity.onGround) {
        bot.setControlState('jump', true);
        bot.setControlState('jump', false);
      }
      return;
    }

    this.seek(bot, target, true);
  }
}
