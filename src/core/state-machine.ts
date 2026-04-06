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
  private tick: number = 0;
  private incomingProjectiles: IncomingProjectile[] = [];

  constructor(
    private readonly bot: Bot,
    private readonly config: FullConfig,
  ) {
    super();
    this.sword = new SwordCombat(bot, config);
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
    this.transition('engaging');
  }

  stop(): void {
    this.manualTarget = undefined;
    this.primaryTarget = undefined;
    this.sword.stop();
    this.projectile.stop();
    this.transition('idle');
  }

  get currentTarget(): Entity | undefined {
    return this.primaryTarget;
  }

  private onTick = (): void => {
    this.tick++;
    this.targetSelector.tick();
    this.scanProjectiles();
    this.updateSnapshot();
    this.runPhase();
  };

  private runPhase(): void {
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
      case 'eating':
        break;
      case 'pearling':
        break;
      case 'bow-combat':
        this.tickBowCombat();
        break;
      case 'dodging':
        break;
      case 'blocking':
        break;
    }

    this.checkTransitions();
  }

  private tickIdle(): void {
    if (this.config.multiEnemy.enabled) {
      const threats = this.targetSelector.getNearbyThreats(this.bot, this.config.generic.viewDistance);
      if (threats.length > 0 && !this.manualTarget) return;
    }

    if (this.config.multiEnemy.assistTeammates) {
      const struggling = this.team.getStruggling();
      if (struggling.length > 0) {
        const first = struggling[0];
        if (first?.nearestEnemy) {
          this.primaryTarget = first.nearestEnemy;
          this.transition('engaging');
          return;
        }
      }
    }
  }

  private tickMelee(): void {
    if (!this.primaryTarget) {
      this.transition('idle');
      return;
    }

    const snap = this.snapshot;
    const isLow = this.health.isLow;

    if (isLow && this.gap.shouldEat(this.bot, this.phase, snap.incomingProjectiles.length > 0)) {
      this.transition('eating');
      void this.doEat();
      return;
    }

    if (this.pearl.shouldThrowDefensive(this.bot)) {
      this.transition('pearling');
      void this.pearl.throwDefensive(this.bot, this.getActiveEnemies());
      return;
    }

    const aggPearl =
      this.config.pearl.enabled && !snap.inRange && this.pearl.shouldThrowAggressive(this.bot, this.primaryTarget);
    if (aggPearl) {
      this.transition('pearling');
      void this.pearl.throwAggressive(this.bot, this.primaryTarget);
      return;
    }

    const dist = this.primaryTarget.position.distanceTo(this.bot.entity.position);
    const inMeleeRange = dist <= this.config.generic.attackRange + 2;

    if (!inMeleeRange && this.config.bow.enabled) {
      if (this.phase !== 'bow-combat') this.transition('bow-combat');
      return;
    }

    if (inMeleeRange && this.phase === 'bow-combat') {
      this.projectile.stop();
      this.transition('engaging');
    }

    if (!this.sword.target || this.sword.target.id !== this.primaryTarget.id) {
      void this.sword.engage(this.primaryTarget);
    }
  }

  private tickBowCombat(): void {
    if (!this.primaryTarget) {
      this.transition('idle');
      return;
    }
    const dist = this.primaryTarget.position.distanceTo(this.bot.entity.position);
    if (dist <= this.config.generic.attackRange + 1) {
      this.projectile.stop();
      this.transition('engaging');
      return;
    }
    if (!this.projectile.isActive) {
      void this.projectile.engage(this.primaryTarget);
    }
  }

  private tickRetreating(): void {
    this.sword.stop();
    this.bot.setControlState('sprint', true);

    if (!this.health.isLow) {
      this.transition('engaging');
      return;
    }

    if (this.gap.shouldEat(this.bot, this.phase, false)) {
      this.transition('eating');
      void this.doEat();
    }
  }

  private checkTransitions(): void {
    const snap = this.snapshot;

    if (this.incomingProjectiles.length > 0 && this.phase !== 'dodging') {
      const incoming = this.incomingProjectiles[0];
      if (incoming && incoming.estimatedImpactTick - this.tick <= 4) {
        this.transition('dodging');
        void this.dodge.handleIncoming(this.bot, incoming);
        return;
      }
    }

    if (this.phase === 'dodging' && this.incomingProjectiles.length === 0) {
      this.transition(this.primaryTarget ? 'engaging' : 'idle');
      return;
    }

    if (this.phase === 'pearling' && !this.pearl.isThrowing) {
      this.transition(this.primaryTarget ? 'engaging' : 'idle');
      return;
    }

    if (this.phase === 'eating' && !this.gap.isEating) {
      this.transition(this.primaryTarget ? 'engaging' : 'idle');
      return;
    }

    if (this.health.isCritical && this.phase !== 'retreating' && this.phase !== 'eating') {
      this.transition('retreating');
      return;
    }

    if (!this.primaryTarget && this.phase !== 'idle') {
      this.transition('idle');
      return;
    }

    if (this.primaryTarget && snap.inRange && snap.comboActive && this.phase === 'engaging') {
      this.transition('combo');
      return;
    }

    if (this.primaryTarget && !snap.inRange && this.phase === 'combo') {
      this.transition('engaging');
      return;
    }

    if (snap.ticksSinceHurt <= 3 && this.phase === 'combo') {
      this.transition('stunned');
      return;
    }

    if (snap.ticksSinceHurt > 10 && this.phase === 'stunned') {
      this.transition('combo');
      return;
    }

    if (this.config.multiEnemy.enabled && this.phase !== 'retreating' && this.phase !== 'eating') {
      const threats = this.targetSelector.getNearbyThreats(this.bot, this.config.generic.viewDistance);
      const best = this.targetSelector.selectPrimary(this.bot, this.primaryTarget, threats, this.config.teammates);
      if (best && best.id !== this.primaryTarget?.id) {
        this.primaryTarget = best;
        this.sword.stop();
        this.transition('engaging');
      }
    }
  }

  private async doEat(): Promise<void> {
    await this.gap.eat(this.bot);
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
      this.transition('idle');
    }
  };

  private transition(next: CombatPhase): void {
    if (this.phase === next) return;
    this.phase = next;
    this.emit('phaseChanged', next);
  }
}
