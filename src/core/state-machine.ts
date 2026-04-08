import {
    EventEmitter
} from 'events'
import {
    BotStateMachine,
    getNestedMachine
} from '@nxg-org/mineflayer-static-statemachine'
import type {
    Bot
} from 'mineflayer'
import type {
    Entity
} from 'prismarine-entity'
import type {
    FullConfig
} from '../config/types.js'
import type {
    CombatPhase,
    CombatSnapshot
} from './combat-state.js'
import {
    createSnapshot
} from './combat-state.js'
import {
    SwordCombat
} from '../combat/sword-combat.js'
import {
    ProjectileHandler
} from '../projectile/projectile-handler.js'
import {
    DodgeController,
    ProjectileScanner
} from '../movement/dodge-controller.js'
import {
    GapHandler
} from '../tactics/gap-handler.js'
import {
    HealthManager
} from '../health/health-manager.js'
import {
    PotionHandler
} from '../health/potion-handler.js'
import {
    TargetSelector
} from '../multi-enemy/target-selector.js'
import {
    TeamHandler
} from '../multi-enemy/team-handler.js'
import type {
    IDecisionAgent
} from '../engine/agent-interface.js'
import {
    createPvpData
} from './pvp-data.js'
import type {
    PvpData
} from './pvp-data.js'
import {
    IdleBehavior
} from './behaviors/idle.js'
import {
    buildTransitions
} from './behaviors/transitions.js'
import '@nxg-org/mineflayer-auto-buff'
import type {
    StateBehaviorBuilder
} from '@nxg-org/mineflayer-static-statemachine/lib/util.js'

const DRAIN_LIMIT = 16

const PHASE_NAME_MAP: Record < string, CombatPhase > = {
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
    private readonly botStateMachine: BotStateMachine < typeof IdleBehavior,
    StateBehaviorBuilder[] >
    private readonly health: HealthManager
    private readonly targetSelector: TargetSelector
    private readonly scanner: ProjectileScanner
    private tick = 0

    constructor(
        private readonly bot: Bot,
        private readonly config: FullConfig,
        agents?: {
            decision?: IDecisionAgent
        },
    ) {
        super()

        const scanner = new ProjectileScanner(bot)
        const sword = new SwordCombat(bot, config, agents?.decision)
        const projectile = new ProjectileHandler(bot, config.bow, config.fireball)
        const dodge = new DodgeController(config.dodge, scanner)
        const health = new HealthManager(bot, config.lowHealth)
        const gap = new GapHandler(config.gap)
        const potions = new PotionHandler(config.jumpBoost)
        const targetSelector = new TargetSelector(config.multiEnemy)
        const team = new TeamHandler(bot, config.teammates)

        this.scanner = scanner
        this.health = health
        this.targetSelector = targetSelector

        this.data = createPvpData(
            config,
            sword,
            projectile,
            dodge,
            health,
            gap,
            potions,
            bot.autoBuff,
            targetSelector,
            team,
        )

        sword.on('attackedTarget', (t: Entity) => this.emit('attackedTarget', t))
        sword.on('startedAttacking', (t: Entity) => this.emit('startedAttacking', t))
        sword.on('stoppedAttacking', () => this.emit('stoppedAttacking'))
        health.on('lowHealth', () => this.onLowHealth())

        const transitions = buildTransitions()
        const rootMachine = getNestedMachine('CombatRoot', transitions, IdleBehavior, []).build()

        this.botStateMachine = new BotStateMachine( {
            bot,
            root: rootMachine,
            data: this.data,
            autoStart: false,
            autoUpdate: false,
        })

        this.botStateMachine.on('stateEntered', (_type, _nested, stateCls) => {
            const name = (stateCls as unknown as {
                stateName?: string
            }).stateName ?? ''
            const mapped = PHASE_NAME_MAP[name]
            if (mapped && mapped !== this.phase) {
                this.phase = mapped
                this.data.snapshot = {
                    ...this.data.snapshot,
                    phase: mapped
                }
                this.emit('phaseChanged', mapped)
            }
        })

        bot.on('physicsTick',
            this.onTick)
        bot.on('entityGone',
            this.onEntityGone)

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
        this.data.projectile.stop()
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
        this.botStateMachine.update()
    }

    private drainStateMachine(): void {
        for (let i = 0; i < DRAIN_LIMIT; i++) {
            const before = this.phase
            this.botStateMachine.update()
            if (this.phase === before) break
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
        this.data.incomingProjectiles = this.scanner.scan(this.tick)
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
            tick: this.tick,
            botHealth: this.bot.health ?? 20,
        }
        this.snapshot = this.data.snapshot
    }

    private onLowHealth(): void {
        if (this.phase === 'retreating' || this.phase === 'eating' || this.phase === 'pearling') return
        if (this.data.potions.shouldDrink(this.bot, 'escape') && this.config.jumpBoost.useForEscape) {
            void this.data.potions.drinkJumpBoost(this.bot)
        }
    }

    private onEntityGone = (entity: Entity): void => {
        if (this.data.entity?.id === entity.id) {
            delete this.data.entity
            this.data.sword.stop()
        }
    }
}