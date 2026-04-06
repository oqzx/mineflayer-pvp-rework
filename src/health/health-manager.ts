import { EventEmitter } from 'events';
import type { Bot } from 'mineflayer';
import type { LowHealthConfig } from '../config/types.js';

export class HealthManager extends EventEmitter {
  private lastHealth: number = 20;
  private readonly lowThreshold: number;

  constructor(
    private readonly bot: Bot,
    config: LowHealthConfig,
  ) {
    super();
    this.lowThreshold = config.threshold;
    this.bot.on('health', () => this.onHealthChange());
  }

  get current(): number {
    return this.bot.health ?? 20;
  }

  get isLow(): boolean {
    return this.current <= this.lowThreshold;
  }

  get isCritical(): boolean {
    return this.current <= this.lowThreshold / 2;
  }

  get tookDamage(): boolean {
    return this.current < this.lastHealth;
  }

  private onHealthChange(): void {
    const hp = this.bot.health ?? 20;
    if (hp < this.lastHealth) this.emit('damaged', this.lastHealth - hp);
    if (hp <= this.lowThreshold && this.lastHealth > this.lowThreshold) this.emit('lowHealth', hp);
    if (hp > this.lastHealth) this.emit('healed', hp - this.lastHealth);
    this.lastHealth = hp;
  }
}
