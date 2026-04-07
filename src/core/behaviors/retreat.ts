import { StateBehavior } from '@nxg-org/mineflayer-static-statemachine';
import type { Bot } from 'mineflayer';
import type { StateMachineData } from '@nxg-org/mineflayer-static-statemachine';
import type { PvpData } from '../pvp-data.js';

export class RetreatBehavior extends StateBehavior {
  static readonly stateName = 'Retreating';

  constructor(bot: Bot, data: StateMachineData) {
    super(bot, data);
  }

  onStateEntered(): void {
    const d = this.data as PvpData;
    d.sword.stop();
    this.bot.setControlState('sprint', true);
    if (d.config.jumpBoost.useForEscape && d.potions.shouldDrink(this.bot, 'escape')) {
      void d.potions.drinkJumpBoost(this.bot);
    }
    void this.applySpeedBuff(d);
  }

  update(): void {
    this.bot.setControlState('sprint', true);
  }

  isFinished(): boolean {
    return false;
  }

  onStateExited(): void {
    this.bot.setControlState('sprint', false);
  }

  private async applySpeedBuff(d: PvpData): Promise<void> {
    if (d.autoBuff.hasBuff('speed')) return;
    if (!d.autoBuff.hasItemForBuff('speed')) return;
    await d.autoBuff.applyEffectsToSelf('speed');
  }
}
