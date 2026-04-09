import { EventEmitter } from 'events'
import { BotStateMachine, getNestedMachine } from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Vec3 } from 'vec3'
import type { FullConfig } from '../config/types.js'
import type { CombatPhase, CombatSnapshot } from './combat-state.js'
import { createSnapshot } from './combat-state.js'
import { SwordCombat } from '../combat/sword-combat.js'
import { ProjectileHandler } from '../projectile/projectile-handler'
import { PearlHandler } from '../projectile/pearl-handler.js'
import {
  DodgeController,
  classifyProjectile,
} from '../movement/dodge-controller.js'
import { GapHandler } from '../tactics/gap-handler.js'
import { HealthManager } from '../health/health-manager.js'
import { PotionHandler } from '../health/potion-handler.js'
import { TargetSelector } from '../multi-enemy/target-selector.js'
import { TeamHandler } from '../multi-enemy/team-handler.js'
import type { IDecisionAgent } from '../engine/agent-interface.js'
import { createPvpData } from './pvp-data.js'
import type { PvpData } from './pvp-data.js'
import { IdleBehavior } from './behaviors/idle.js'
import { buildTransitions } from './behaviors/transitions.js'
import '@nxg-org/mineflayer-auto-buff'
import type { StateBehaviorBuilder } from '@nxg-org/mineflayer-static-statemachine/lib/util.js'

const DRAIN_LIMIT = 16
const SLOW_STATE_MACHINE_UPDATE_MS = 2
type TrackedThreatInfo = ReturnType<Bot['projectiles']['getIncomingProjectiles']>[number]

const PHASE_NAME_MAP: Record<string, CombatPhase> = {
  Idle: 'idle',
  Engaging: 'engaging',
  Combo: 'combo',
  Stunned: 'stunned',
  BackingOff: 'backing-off',
  CriticalSetup: 'critical-setup',
  Retreating: 'retreating',
  BowCombat: 'bow-combat',
  Dodging: 'dodging',
  Eating: 'eating',
  Pearling: 'pearling',
  Stuck: 'stuck',
}

export class StateMachine extends EventEmitter {
  public phase: CombatPhase = 'idle'
  public snapshot: CombatSnapshot = createSnapshot()

  private readonly data: PvpData
  private readonly botStateMachine: BotStateMachine<typeof IdleBehavior, StateBehaviorBuilder[]>
  private readonly health: HealthManager
  private readonly targetSelector: TargetSelector
  private tick = 0

  constructor(
    private readonly bot: Bot,
    private readonly config: FullConfig,
    agents?: { decision?: IDecisionAgent },
  ) {
    super()

    const sword = new SwordCombat(bot, config, agents?.decision)
    const projectile = new ProjectileHandler(bot, config.bow, config.fireball)
    const pearl = new PearlHandler(config.pearl)
    const dodge = new DodgeController(config.dodge)
    const health = new HealthManager(bot, config.lowHealth)
    const gap = new GapHandler(config.gap)
    const potions = new PotionHandler(config.jumpBoost)
    const targetSelector = new TargetSelector(config.multiEnemy)
    const team = new TeamHandler(bot, config.teammates)

    this.health = health
    this.targetSelector = targetSelector

    this.data = createPvpData(
      config,
      sword,
      projectile,
      pearl,
      dodge,
      health,
      gap,
      potions,
      bot.autoBuff,
      targetSelector,
      team,
    )

    this.bot.projectiles.detectIncomingProjectiles = true
    this.bot.projectiles.detectAimingEntities = true

    this.bot.ender.maxTicks = 100;
    this.bot.ender.dvStep = 360;
    this.bot.ender.epsilon = 1e-2;

    sword.on('attackedTarget', (t: Entity) => {
      console.log(`[event] tick=${this.tick} attackedTarget -> ${t.username ?? t.name ?? t.id}`)
      this.emit('attackedTarget', t)
    })
    sword.on('startedAttacking', (t: Entity) => {
      console.log(`[event] tick=${this.tick} startedAttacking -> ${t.username ?? t.name ?? t.id}`)
      this.emit('startedAttacking', t)
    })
    sword.on('stoppedAttacking', () => {
      console.log(`[event] tick=${this.tick} stoppedAttacking`)
      this.emit('stoppedAttacking')
    })
    health.on('lowHealth', () => this.onLowHealth())

    const transitions = buildTransitions()
    const rootMachine = getNestedMachine('CombatRoot', transitions, IdleBehavior, []).build()

    this.botStateMachine = new BotStateMachine({
      bot,
      root: rootMachine,
      data: this.data,
      autoStart: false,
      autoUpdate: false,
    })

    this.botStateMachine.on('stateEntered', (_type, _nested, stateCls) => {
      const name = (stateCls as unknown as { stateName?: string }).stateName ?? ''
      const mapped = PHASE_NAME_MAP[name]
      if (mapped && mapped !== this.phase) {
        this.phase = mapped
        this.data.snapshot = { ...this.data.snapshot, phase: mapped }
        console.log(`[event] tick=${this.tick} pvpPhaseChanged -> ${mapped}`)
        this.emit('phaseChanged', mapped)
      }
    })

    bot.on('physicsTick', this.onTick)
    bot.on('move', this.onBotMove)
    bot.on('forcedMove', this.onForcedMove)
    bot.on('entitySpawn', this.onEntitySpawn)
    bot.on('entityDead', this.onEntityGone)
    bot.on('entityGone', this.onEntityGone)

    this.botStateMachine.start(false)
  }

  attack(target: Entity): void {
    this.data.entity = target
    this.data.sword.stop()
    this.drainStateMachine()
  }

  stop(): void {
    delete this.data.entity
    this.data.sword.stop()
    void this.data.projectile.stop()
    this.drainStateMachine()
  }

  get currentTarget(): Entity | undefined {
    return this.data.entity
  }

  private onTick = (): void => {
    this.tick++
    this.data.tick = this.tick
    this.targetSelector.tick()
    this.scanProjectiles()
    this.updateSnapshot()
    this.maybeRerouteTarget()
    this.runStateMachineUpdate('tick')
  }

  private drainStateMachine(): void {
    for (let i = 0; i < DRAIN_LIMIT; i++) {
      const before = this.phase
      this.runStateMachineUpdate(`drain:${i}`)
      if (this.phase === before) break
    }
  }

  private runStateMachineUpdate(source: string): void {
    const start = performance.now()
    this.botStateMachine.update()
    const durationMs = performance.now() - start
    if (durationMs >= SLOW_STATE_MACHINE_UPDATE_MS) {
      console.log(
        `[perf] tick=${this.tick} stateMachine.update source=${source} phase=${this.phase} durationMs=${durationMs.toFixed(3)}`,
      )
    }
  }

  private maybeRerouteTarget(): void {
    if (!this.config.multiEnemy.enabled) return
    const phase = this.phase
    if (phase === 'retreating' || phase === 'eating' || phase === 'pearling') return
    const threats = this.targetSelector.getNearbyThreats(this.bot, this.config.generic.viewDistance)
    const best = this.targetSelector.selectPrimary(
      this.bot,
      this.data.entity,
      threats,
      this.config.teammates,
    )
    if (best && best.id !== this.data.entity?.id) {
      this.data.entity = best
      this.data.sword.stop()
    }
  }

  private scanProjectiles(): void {
    this.data.incomingProjectiles = this.bot.projectiles
      .getIncomingProjectiles()
      .map((info) => this.mapTrackedThreat(info))
      .sort((a, b) => a.estimatedImpactTick - b.estimatedImpactTick)


    this.data.aimingEntities = this.bot.projectiles
      .getAimingEntities()
      .map((info) => {
        return this.mapTrackedThreat(info)
      })
      .sort((a, b) => a.estimatedImpactTick - b.estimatedImpactTick)
  }

  private updateSnapshot(): void {
    const partial = this.data.sword.buildSnapshot(this.tick)
    this.data.snapshot = {
      ...this.data.snapshot,
      ...partial,
      phase: this.phase,
      target: this.data.entity,
      targets: this.targetSelector.getNearbyThreats(this.bot, this.config.generic.viewDistance),
      incomingProjectiles: this.data.incomingProjectiles,
      aimingEntities: this.data.aimingEntities,
      tick: this.tick,
      botHealth: this.bot.health ?? 20,
    }
    this.snapshot = this.data.snapshot
  }

  private mapTrackedThreat({ entity, shotInfo }: TrackedThreatInfo) {
    const impactPosition =
      shotInfo.intersectPos?.clone() ?? shotInfo.closestPoint?.clone() ?? entity.position.clone()

    return {
      entity,
      type: classifyProjectile(entity) ?? 'other',
      estimatedImpactTick: this.tick + Math.max(0, Math.ceil(shotInfo.totalTicks)),
      impactPosition,
    }
  }

  private onLowHealth(): void {
    if (this.phase === 'retreating' || this.phase === 'eating' || this.phase === 'pearling') return
    if (this.data.potions.shouldDrink(this.bot, 'escape') && this.config.jumpBoost.useForEscape) {
      void this.data.potions.drinkJumpBoost(this.bot)
    }
  }

  private onEntitySpawn = async (entity: Entity): Promise<void> => {

    // lol rough fix for testing
    // while (true) {
    //   if (entity.velocity.floored().equals(entity.velocity))
    //   await new Promise((res) => setTimeout(res, 10))
    //   else break
    // }

    // console.log(entity.position, this.data.entity?.position, this.data.entity?.position.distanceTo(entity.position))


    await new Promise<void>((res) => {
      const listener = async (e: Entity) => {
      
          if (e.id !== entity.id) return;
          if (e.type === "player") return;
      
          this.data.pearl.onEntitySpawn(this.bot, entity, this.tick, this.data.entity)
          this.bot.off("entityMoved", listener)
          this.bot.off("entityVelocity", listener);
          res()
        }
    
        this.bot.on("entityMoved", listener);
        this.bot.on("entityVelocity", listener);

      
        setTimeout(() => {
      this.bot.off("entityMoved", listener)
        this.bot.off("entityVelocity", listener)
        res();
        }, 500);
    })
  }

  private onBotMove = (previousPosition: Vec3): void => {
    this.data.pearl.onBotMove(this.bot, previousPosition)
  }

  private onForcedMove = (): void => {
    this.data.pearl.onForcedMove(this.bot)
  }

  private onEntityGone = (entity: Entity): void => {
    this.data.pearl.onEntityGone(this.bot, entity)
    if (this.data.entity?.id === entity.id) {
      delete this.data.entity
      this.data.sword.stop()
    }
  }
}
