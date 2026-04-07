import { EventEmitter } from 'events';
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { FullConfig } from '../config/types.js';
import type { CombatPhase, CombatSnapshot, IncomingProjectile } from './combat-state.js';
import { createSnapshot } from './combat-state.js';
import { SwordCombat } from '../combat/sword-combat.js';
import { ProjectileHandler } from '../projectile/projectile-handler.js';
import { PearlHandler } from '../projectile/pearl-handler.js';
import {
  DodgeController,
  classifyProjectile,
  isHeadingToward,
  estimateImpactTick,
} from '../movement/dodge-controller.js';
import { GapHandler } from '../tactics/gap-handler.js';
import { HealthManager } from '../health/health-manager.js';
import { PotionHandler } from '../health/potion-handler.js';
import { TargetSelector } from '../multi-enemy/target-selector.js';
import { TeamHandler } from '../multi-enemy/team-handler.js';
import type { IDecisionAgent } from '../engine/agent-interface.js';

const DRAIN_LIMIT = 16;

const MELEE_PHASES = new Set<CombatPhase>([
  'engaging', 'combo', 'backing-off', 'critical-setup', 'stunned',
]);

export class StateMachine extends EventEmitter {
  public phase: CombatPhase = 'idle';
  public snapshot: CombatSnapshot = createSnapshot();

  private readonly sword: SwordCombat;
  private readonly projectile: ProjectileHandler;
  private readonly pearl: PearlHandler;
  private readonly dodge: DodgeController;
  private readonly gap: GapHandler;
  private readonly health: HealthManager;
  private readonly potions: PotionHandler;
  private readonly targetSelector: TargetSelector;
  private readonly team: TeamHandler;

  private primaryTarget: Entity | undefined = undefined;
  private manualTarget: Entity | undefined = undefined;
  private tick = 0;
  private incomingProjectiles: IncomingProjectile[] = [];

  constructor(
    private readonly bot: Bot,
    private readonly config: FullConfig,
    agents?: { decision?: IDecisionAgent },
  ) {
    super();
    this.sword = new SwordCombat(bot, config, agents?.decision);
    this.projectile = new ProjectileHandler(bot, config.bow, config.fireball);
    this.pearl = new PearlHandler(config.pearl);
    this.dodge = new DodgeController(config.dodge);
    this.gap = new GapHandler(config.gap);
    this.health = new HealthManager(bot, config.lowHealth);
    this.potions = new PotionHandler(config.jumpBoost);
    this.targetSelector = new TargetSelector(config.multiEnemy);
    this.team = new TeamHandler(bot, config.teammates);

    this.sword.on('attackedTarget', (t: Entity) => this.emit('attackedTarget', t));
    this.sword.on('startedAttacking', (t: Entity) => this.emit('startedAttacking', t));
    this.sword.on('stoppedAttacking', () => this.emit('stoppedAttacking'));

    this.health.on('lowHealth', () => this.onLowHealth());

    this.bot.on('physicsTick', this.onTick);
    this.bot.on('entitySpawn', this.onEntitySpawn);
    this.bot.on('entityGone', this.onEntityGone);
  }

  attack(target: Entity): void {
    this.manualTarget = target;
    this.primaryTarget = target;
    this.applyTransition('engaging');
    this.drainTransitions();
  }

  stop(): void {
    this.manualTarget = undefined;
    this.primaryTarget = undefined;
    this.sword.stop();
    this.projectile.stop();
    this.applyTransition('idle');
  }

  get currentTarget(): Entity | undefined {
    return this.primaryTarget;
  }

  private onTick = (): void => {
    this.tick++;
    this.targetSelector.tick();
    this.scanProjectiles();
    this.updateSnapshot();
    this.tickCurrentPhase();
    this.drainTransitions();
  };

  private tickCurrentPhase(): void {
    switch (this.phase) {
      case 'idle':
        this.tickIdle();
        break;
      case 'engaging':
      case 'combo':
      case 'backing-off':
      case 'critical-setup':
      case 'stunned':
        this.tickMelee();
        break;
      case 'retreating':
        this.tickRetreating();
        break;
      case 'bow-combat':
        this.tickBowCombat();
        break;
    }
  }

  private drainTransitions(): void {
    for (let i = 0; i < DRAIN_LIMIT; i++) {
      const next = this.resolveNextPhase();
      if (next === null) break;
      this.applyTransition(next);
    }
  }

  private resolveNextPhase(): CombatPhase | null {
    const snap = this.snapshot;
    const phase = this.phase;

    if (this.incomingProjectiles.length > 0 && phase !== 'dodging') {
      const proj = this.incomingProjectiles[0];
      if (proj && proj.estimatedImpactTick - this.tick <= 4) return 'dodging';
    }

    if (phase === 'dodging' && this.incomingProjectiles.length === 0) {
      return this.primaryTarget ? 'engaging' : 'idle';
    }

    if (phase === 'pearling' && !this.pearl.isThrowing) {
      return this.primaryTarget ? 'engaging' : 'idle';
    }

    if (phase === 'eating' && !this.gap.isEating) {
      return this.primaryTarget ? 'engaging' : 'idle';
    }

    if (this.health.isCritical && phase !== 'retreating' && phase !== 'eating') {
      return 'retreating';
    }

    if (!this.primaryTarget && phase !== 'idle') {
      return 'idle';
    }

    if (this.primaryTarget && phase === 'idle') {
      return 'engaging';
    }

    if (
      this.config.multiEnemy.enabled &&
      phase !== 'retreating' &&
      phase !== 'eating' &&
      phase !== 'pearling'
    ) {
      const threats = this.targetSelector.getNearbyThreats(this.bot, this.config.generic.viewDistance);
      const best = this.targetSelector.selectPrimary(this.bot, this.primaryTarget, threats, this.config.teammates);
      if (best && best.id !== this.primaryTarget?.id) {
        this.primaryTarget = best;
        this.sword.stop();
        return 'engaging';
      }
    }

    if (MELEE_PHASES.has(phase) && this.primaryTarget) {
      if (this.health.isLow && this.gap.shouldEat(this.bot, phase, snap.incomingProjectiles.length > 0)) {
        return 'eating';
      }

      if (this.pearl.shouldThrowDefensive(this.bot)) {
        return 'pearling';
      }

      if (
        this.config.pearl.enabled &&
        !snap.inRange &&
        this.pearl.shouldThrowAggressive(this.bot, this.primaryTarget)
      ) {
        return 'pearling';
      }

      const dist = this.primaryTarget.position.distanceTo(this.bot.entity.position);
      if (dist > this.config.generic.attackRange + 2 && this.config.bow.enabled) {
        return 'bow-combat';
      }
    }

    if (phase === 'retreating') {
      if (!this.health.isLow) return 'engaging';
      if (this.gap.shouldEat(this.bot, phase, false)) return 'eating';
    }

    if (phase === 'bow-combat' && this.primaryTarget) {
      const dist = this.primaryTarget.position.distanceTo(this.bot.entity.position);
      if (dist <= this.config.generic.attackRange + 1) return 'engaging';
    }

    if (this.primaryTarget && snap.inRange && snap.comboActive && phase === 'engaging') {
      return 'combo';
    }

    if (this.primaryTarget && !snap.inRange && phase === 'combo') {
      return 'engaging';
    }

    if (snap.ticksSinceHurt <= 3 && phase === 'combo') {
      return 'stunned';
    }

    if (snap.ticksSinceHurt > 10 && phase === 'stunned') {
      return 'combo';
    }

    return null;
  }

  private applyTransition(next: CombatPhase): void {
    if (this.phase === next) return;
    this.onExit(this.phase);
    this.phase = next;
    this.emit('phaseChanged', next);
    this.onEnter(next);
  }

  private onExit(phase: CombatPhase): void {
    if (phase === 'bow-combat') {
      this.projectile.stop();
    }
  }

  private onEnter(phase: CombatPhase): void {
    switch (phase) {
      case 'eating':
        void this.gap.eat(this.bot);
        break;
      case 'pearling':
        void this.startPearl();
        break;
      case 'dodging': {
        const proj = this.incomingProjectiles[0];
        if (proj) void this.dodge.handleIncoming(this.bot, proj);
        break;
      }
      case 'retreating':
        this.sword.stop();
        break;
    }
  }

  private tickIdle(): void {
    if (this.manualTarget) return;

    if (this.config.multiEnemy.assistTeammates) {
      const struggling = this.team.getStruggling();
      const first = struggling[0];
      if (first?.nearestEnemy) {
        this.primaryTarget = first.nearestEnemy;
      }
    }
  }

  private tickMelee(): void {
    if (!this.primaryTarget) return;
    if (!this.sword.target || this.sword.target.id !== this.primaryTarget.id) {
      void this.sword.engage(this.primaryTarget);
    }
  }

  private tickBowCombat(): void {
    if (!this.primaryTarget) return;
    if (!this.projectile.isActive) {
      void this.projectile.engage(this.primaryTarget);
    }
  }

  private tickRetreating(): void {
    this.bot.setControlState('sprint', true);
  }

  private async startPearl(): Promise<void> {
    if (!this.primaryTarget) return;

    if (this.pearl.shouldThrowDefensive(this.bot)) {
      void this.pearl.throwDefensive(this.bot, this.getActiveEnemies());
    } else {
      void this.pearl.throwAggressive(this.bot, this.primaryTarget);
    }
  }

  private scanProjectiles(): void {
    this.incomingProjectiles = [];
    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || entity === this.bot.entity) continue;
      const type = classifyProjectile(entity);
      if (!type) continue;
      if (!isHeadingToward(entity, this.bot.entity)) continue;
      const impactTick = this.tick + estimateImpactTick(entity, this.bot.entity);
      this.incomingProjectiles.push({
        entity,
        type,
        estimatedImpactTick: impactTick,
        impactPosition: entity.position.clone(),
      });
    }
    this.incomingProjectiles.sort((a, b) => a.estimatedImpactTick - b.estimatedImpactTick);
  }

  private updateSnapshot(): void {
    const partial = this.sword.buildSnapshot(this.tick);
    this.snapshot = {
      ...this.snapshot,
      ...partial,
      phase: this.phase,
      target: this.primaryTarget,
      targets: this.getActiveEnemies(),
      incomingProjectiles: this.incomingProjectiles,
      tick: this.tick,
      botHealth: this.bot.health ?? 20,
    };
  }

  private getActiveEnemies(): Entity[] {
    return this.targetSelector.getNearbyThreats(this.bot, this.config.generic.viewDistance);
  }

  private onLowHealth(): void {
    if (this.phase !== 'retreating' && this.phase !== 'eating' && this.phase !== 'pearling') {
      if (this.config.jumpBoost.useForEscape && this.potions.shouldDrink(this.bot, 'escape')) {
        void this.potions.drinkJumpBoost(this.bot);
      }
    }
  }

  private onEntitySpawn = (entity: Entity): void => {
    if (entity.name === 'ender_pearl') {
      this.pearl.trackEnemyPearl(entity, this.tick);
    }
  };

  private onEntityGone = (entity: Entity): void => {
    this.pearl.removeEnemyPearl(entity.id);
    if (this.primaryTarget?.id === entity.id) {
      this.primaryTarget = undefined;
      this.sword.stop();
      this.applyTransition('idle');
    }
  };
}
