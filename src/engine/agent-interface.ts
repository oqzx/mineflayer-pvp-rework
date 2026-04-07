import type { CombatSnapshot } from '../core/combat-state.js'
import type { EnemyProfile } from '../adaptation/session-memory.js'
import type { CombatStrategy } from '../adaptation/style-adapter.js'
import type { PredictionFrame } from './prediction-layer.js'
import type { DecisionFrame } from './decision-engine.js'

export interface IDecisionAgent {
  evaluate(
    snapshot: CombatSnapshot,
    profile: EnemyProfile,
    strategy: CombatStrategy,
    prediction: PredictionFrame,
    tick: number,
  ): DecisionFrame
  getLast(): DecisionFrame | null
}

export type AgentFactory = (config: {
  aggressionBias: number
  defensiveBias: number
  retreatHealthThreshold: number
}) => IDecisionAgent
