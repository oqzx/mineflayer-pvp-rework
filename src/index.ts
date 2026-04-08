import { loader as lookPlugin } from '@nxg-org/mineflayer-smooth-look'
import utilPlugin from '@nxg-org/mineflayer-util-plugin'
import trackerPlugin from '@nxg-org/mineflayer-tracker'
import enderPlugin from '@nxg-org/mineflayer-ender'
import autoBuffPlugin from '@nxg-org/mineflayer-auto-buff'
import { pathfinder as pathfinderPlugin } from 'mineflayer-pathfinder'
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { StateMachine } from './core/state-machine.js'
import { defaultConfig } from './config/defaults.js'
import type { FullConfig } from './config/types.js'
import type { IDecisionAgent } from './engine/agent-interface.js'
import 'mineflayer-pathfinder'

export type { IDecisionAgent } from './engine/agent-interface.js'
export type { AgentFactory } from './engine/agent-interface.js'
export type { DecisionFrame, ActionScore } from './engine/decision-engine.js'

export type AgentOverrides = {
  decision?: IDecisionAgent
}

declare module 'mineflayer' {
  interface Bot {
    pvp: PvpController
  }
  interface BotEvents {
    attackedTarget: (target: Entity) => void
    stoppedAttacking: () => void
    startedAttacking: (target: Entity) => void
    pvpPhaseChanged: (phase: string) => void
  }
}

export class PvpController {
  private readonly stateMachine: StateMachine

  constructor(
    private readonly bot: Bot,
    config: FullConfig,
    agents?: AgentOverrides,
  ) {
    this.stateMachine = new StateMachine(bot, config, agents)
    this.stateMachine.on('attackedTarget', (t: Entity) => bot.emit('attackedTarget', t))
    this.stateMachine.on('startedAttacking', (t: Entity) => bot.emit('startedAttacking', t))
    this.stateMachine.on('stoppedAttacking', () => bot.emit('stoppedAttacking'))
    this.stateMachine.on('phaseChanged', (p: string) => bot.emit('pvpPhaseChanged', p))
  }

  attack(target: Entity): void {
    this.stateMachine.attack(target)
  }

  stop(): void {
    this.stateMachine.stop()
  }

  get phase(): string {
    return this.stateMachine.phase
  }

  get target(): Entity | undefined {
    return this.stateMachine.currentTarget
  }
}

export default function plugin(
  bot: Bot,
  config: Partial<FullConfig> = {},
  agents?: AgentOverrides,
): void {
  if (!bot.util) bot.loadPlugin(utilPlugin)
  if (!bot.tracker || !bot.projectiles) bot.loadPlugin(trackerPlugin)
  if (!bot.smoothLook) bot.loadPlugin(lookPlugin)
  if (!(bot as Bot & { pathfinder?: unknown }).pathfinder) bot.loadPlugin(pathfinderPlugin)
  if (!(bot as Bot & { ender?: unknown }).ender) bot.loadPlugin(enderPlugin)
  if (!(bot as Bot & { autoBuff?: unknown }).autoBuff) bot.loadPlugin(autoBuffPlugin)

  const merged: FullConfig = { ...defaultConfig, ...config }
  bot.pvp = new PvpController(bot, merged, agents)
}

export { defaultConfig } from './config/defaults.js'
export type { FullConfig } from './config/types.js'
export type { CombatPhase } from './core/combat-state.js'
export type Range = { min: number; max: number }

export type GenericConfig = {
  attackRange: number
  viewDistance: number
  tooCloseRange: number
  enemyReach: number
  hitThroughWalls: boolean
  missChance: number
  respectIframes: boolean
}

export type CpsConfig = {
  max: number
  engagingRange: Range
  comboRange: Range
}

export type WTapConfig = {
  enabled: boolean
  everyHits: Range
}

export type BlockHitConfig = {
  enabled: boolean
  everyHits: Range
  holdDuration: Range
  postDuration: Range
}

export type StrafeConfig = {
  enabled: boolean
  mode: 'circle' | 'random' | 'intelligent' | 'predictive'
  maxAngleOffset: number
  durationJitter: Range
  pauseProbability: number
  pauseDurationTicks: Range
  circleSwitchEnabled: boolean
  circleSwitchIntervalHits: Range
  predictiveNoiseFactor: number
}

export type RotateConfig = {
  enabled: boolean
  smooth: boolean
  lookAtHidden: boolean
  mode: 'legit' | 'constant' | 'silent' | 'ignore'
  microSaccadeAmplitude: number
  microSaccadeFrequency: number
  lookAwayProbability: number
  lookAwayDurationTicks: Range
  overshootEnabled: boolean
  overshootAmplitude: number
  overshootRecoveryFactor: number
  fittsBias: number
}

export type CriticalConfig = {
  enabled: boolean
  mode: 'hop' | 'shorthop'
  attemptRange: number
  reactionEnabled: boolean
  maxWaitTicks: number
  maxWaitDistance: number
  maxPreemptiveTicks: number
}

export type ShieldConfig = {
  enabled: boolean
  mode: 'legit' | 'blatant'
  disableEnabled: boolean
  disableMode: 'single' | 'double'
}

export type FollowConfig = {
  mode: 'standard' | 'jump'
  distance: number
  predictive: boolean
  predictTicks: number
}

export type BowConfig = {
  enabled: boolean
  preferOverFireball: boolean
  aimBackend: 'shot-planner' | 'bow-aiming'
  leadIterations: number
  bridgeKnockbackEnabled: boolean
}

export type FireballConfig = {
  enabled: boolean
  deflectRange: number
  deflectClickInterval: Range
}

export type PearlConfig = {
  enabled: boolean
  aggressiveRange: number
  throwHuntdown: boolean
  defensiveEnabled: boolean
  voidFallThreshold: number
  safeLandingSearchRadius: number
}

export type DodgeConfig = {
  enabled: boolean
  reactionDelay: Range
  dodgeDistance: number
}

export type GapConfig = {
  enabled: boolean
  healthThreshold: number
  eatDuringCombat: boolean
  shieldWhileEating: boolean
}

export type LowHealthConfig = {
  threshold: number
  extendedBlockEnabled: boolean
  blockHoldDuration: Range
  preferBlockOverAttack: boolean
}

export type MultiEnemyConfig = {
  enabled: boolean
  assistTeammates: boolean
}

export type JumpBoostConfig = {
  enabled: boolean
  useForHeightAdvantage: boolean
  useForEscape: boolean
  useForTowering: boolean
}

export type HumanizationConfig = {
  reactionDelay: Range
  rotateSmoothFactor: number
  movementNoise: number
  attackJitterMs: Range
  cpsVarianceFactor: number
  postHitPauseProbability: number
  postHitPauseDurationMs: Range
  strafeJitterAmplitude: number
  strafeJitterFrequency: number
  sprintToggleNoiseProbability: number
  jumpTimingVarianceTicks: number
  eyeHeightVarianceFactor: number
  mouseAccelerationFactor: number
  angleCorrectionThreshold: number
  angleCorrectionSpeed: number
  focusLapseFrequency: number
  focusLapseDurationTicks: Range
  wristFatigueEnabled: boolean
  wristFatigueCpsReduction: number
  clickReleaseDelayMs: Range
  naturalDecelerationEnabled: boolean
  framerateSim: Range
  subTickMouseMovements: boolean
}

export type AdaptationConfig = {
  enabled: boolean
  minDataPoints: number
}

export type FatigueConfig = {
  enabled: boolean
  onsetTicks: number
  cpsPenaltyFactor: number
  strafeFrequencyPenaltyFactor: number
  recoveryTicks: number
}

export type DecisionEngineConfig = {
  enabled: boolean
  aggressionBias: number
  defensiveBias: number
  updateIntervalTicks: number
  retreatHealthThreshold: number
}

export type BehaviorBlendConfig = {
  enabled: boolean
  smoothingFactor: number
  strafeBaseWeight: number
  hitSelectBaseWeight: number
  retreatBaseWeight: number
}

export type PredictionConfig = {
  enabled: boolean
  velocityHistoryLen: number
  positionLeadTicks: number
  attackPatternMemoryLen: number
  movementEntropyWindow: number
}
