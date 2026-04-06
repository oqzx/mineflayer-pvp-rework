import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Item } from 'prismarine-item';
import type { ShieldConfig } from '../config/types.js';

export class ShieldManager {
  private toggleOverride: boolean = false;
  private switchOverride: boolean = false;
  private previousWeapon: string = 'sword';

  constructor(private readonly config: ShieldConfig) {}

  get isOverrideActive(): boolean {
    return this.toggleOverride || this.switchOverride;
  }

  isEquipped(bot: Bot): boolean {
    if (bot.supportFeature('doesntHaveOffHandSlot')) return false;
    const slot = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
    return slot?.name.includes('shield') ?? false;
  }

  isTargetShielding(target: Entity): boolean {
    const shieldSlot = target.equipment[1];
    return (target.metadata[8] as unknown as number) === 3 && shieldSlot?.name === 'shield';
  }

  async tryDisableShield(bot: Bot, target: Entity, equip: (w: Item) => Promise<boolean>): Promise<void> {
    if (!this.config.disableEnabled || this.switchOverride) return;
    if (!this.isTargetShielding(target)) return;

    const axe = bot.util.inv.getAllItems().find((i) => i?.name.includes('_axe'));
    if (!axe) return;

    this.switchOverride = true;
    this.previousWeapon = 'sword';

    const switched = await equip(axe);
    if (!switched) {
      this.switchOverride = false;
      return;
    }

    await bot.waitForTicks(3);
    bot.attack(target);

    if (this.config.disableMode === 'double') {
      await bot.waitForTicks(3);
      bot.attack(target);
    }

    this.switchOverride = false;
  }

  async restoreSword(bot: Bot, equip: (w: Item) => Promise<boolean>): Promise<void> {
    if (this.switchOverride) return;
    const sword = bot.util.inv.getAllItems().find((i) => i?.name.includes('sword'));
    if (sword) await equip(sword);
  }

  deactivate(bot: Bot): void {
    if (this.isEquipped(bot) && this.config.mode === 'legit') {
      bot.deactivateItem();
    }
  }

  activate(bot: Bot): void {
    if (this.isEquipped(bot)) {
      bot.activateItem(true);
    }
  }

  setToggleOverride(value: boolean): void {
    this.toggleOverride = value;
  }
}
