import { StateBehavior } from '@nxg-org/mineflayer-static-statemachine';
import type { Bot } from 'mineflayer';
import type { StateMachineData } from '@nxg-org/mineflayer-static-statemachine';
import { Results } from '@nxg-org/mineflayer-auto-buff';
import type { PvpData } from '../pvp-data.js';

export class EatingBehavior extends StateBehavior {
  static readonly stateName = 'Eating';

  private done = false;

  constructor(bot: Bot, data: StateMachineData) {
    super(bot, data);
  }

  onStateEntered(): void {
    this.done = false;
    void this.heal();
  }

  update(): void {}

  isFinished(): boolean {
    return this.done;
  }

  onStateExited(): void {
    this.done = false;
  }

  private async heal(): Promise<void> {
    const d = this.data as PvpData;
    const result = await this.tryInstantHealth(d);
    if (result !== Results.SUCCESS && result !== Results.ALREADY_BUFFED) {
      await d.gap.eat(this.bot);
    }
    this.done = true;
  }

  private async tryInstantHealth(d: PvpData): Promise<Results> {
    if (d.autoBuff.hasBuff('instant health')) return Results.ALREADY_BUFFED;
    if (!d.autoBuff.hasItemForBuff('instant health')) return Results.FAIL;
    return d.autoBuff.applyEffectsToSelf('instant health');
  }
}
