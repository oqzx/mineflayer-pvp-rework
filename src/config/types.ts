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

export type FullConfig = {
  generic: GenericConfig
  cps: CpsConfig
  wTap: WTapConfig
  blockHit: BlockHitConfig
  strafe: StrafeConfig
  rotate: RotateConfig
  critical: CriticalConfig
  shield: ShieldConfig
  follow: FollowConfig
  bow: BowConfig
  fireball: FireballConfig
  pearl: PearlConfig
  dodge: DodgeConfig
  gap: GapConfig
  lowHealth: LowHealthConfig
  multiEnemy: MultiEnemyConfig
  jumpBoost: JumpBoostConfig
  humanization: HumanizationConfig
  adaptation: AdaptationConfig
  fatigue: FatigueConfig
  decisionEngine: DecisionEngineConfig
  behaviorBlend: BehaviorBlendConfig
  prediction: PredictionConfig
  teammates: string[]
}
