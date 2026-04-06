import { loader as lookPlugin } from '@nxg-org/mineflayer-smooth-look';
import utilPlugin from '@nxg-org/mineflayer-util-plugin';
import trackerPlugin from '@nxg-org/mineflayer-tracker';
import { pathfinder as pathfinderPlugin } from 'mineflayer-pathfinder';
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { StateMachine } from './core/state-machine.js';
import { defaultConfig } from './config/defaults.js';
import type { FullConfig } from './config/types.js';
import 'mineflayer-pathfinder';

declare module 'mineflayer' {
  interface Bot {
    pvp: PvpController;
  }
  interface BotEvents {
    attackedTarget: (target: Entity) => void;
    stoppedAttacking: () => void;
    startedAttacking: (target: Entity) => void;
    pvpPhaseChanged: (phase: string) => void;
  }
}

export class PvpController {
  private readonly stateMachine: StateMachine;

  constructor(
    private readonly bot: Bot,
    config: FullConfig,
  ) {
    this.stateMachine = new StateMachine(bot, config);
    this.stateMachine.on('attackedTarget', (t: Entity) => bot.emit('attackedTarget', t));
    this.stateMachine.on('startedAttacking', (t: Entity) => bot.emit('startedAttacking', t));
    this.stateMachine.on('stoppedAttacking', () => bot.emit('stoppedAttacking'));
    this.stateMachine.on('phaseChanged', (p: string) => bot.emit('pvpPhaseChanged', p));
  }

  attack(target: Entity): void {
    this.stateMachine.attack(target);
  }

  stop(): void {
    this.stateMachine.stop();
  }

  get phase(): string {
    return this.stateMachine.phase;
  }

  get target(): Entity | undefined {
    return this.stateMachine.currentTarget;
  }
}

export default function plugin(bot: Bot, config: Partial<FullConfig> = {}): void {
  if (!bot.util) bot.loadPlugin(utilPlugin);
  if (!bot.tracker || !bot.projectiles) bot.loadPlugin(trackerPlugin);
  if (!bot.smoothLook) bot.loadPlugin(lookPlugin);
  if (!(bot as Bot & { pathfinder?: unknown }).pathfinder) bot.loadPlugin(pathfinderPlugin);
  const merged: FullConfig = { ...defaultConfig, ...config };
  bot.pvp = new PvpController(bot, merged);
}

export { defaultConfig } from './config/defaults.js';
export type { FullConfig } from './config/types.js';
export type { CombatPhase } from './core/combat-state.js';
