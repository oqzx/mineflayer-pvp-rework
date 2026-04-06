import type { CombatSnapshot } from '../core/combat-state.js';
import type { EnemyProfile } from '../adaptation/session-memory.js';
import type { CombatStrategy } from '../adaptation/style-adapter.js';
import type { PredictionFrame } from './prediction-layer.js';
import type { DecisionEngineConfig } from '../config/types.js';

export type ActionScore = {
  attack: number;
  retreat: number;
  strafeLeft: number;
  strafeRight: number;
  block: number;
  criticalSetup: number;
  wTap: number;
  track: number;
};

export type DecisionFrame = {
  scores: ActionScore;
  primaryAction: keyof ActionScore;
  confidence: number;
  tick: number;
  aggressionLevel: number;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export class DecisionEngine {
  private lastFrame: DecisionFrame | null = null;

  constructor(private readonly config: DecisionEngineConfig) {}

  evaluate(
    snapshot: CombatSnapshot,
    profile: EnemyProfile,
    strategy: CombatStrategy,
    prediction: PredictionFrame,
    tick: number,
  ): DecisionFrame {
    if (!this.config.enabled) {
      return this.defaultFrame(tick);
    }

    const scores = this.computeScores(snapshot, profile, strategy, prediction);
    const primaryAction = this.selectPrimary(scores);
    const confidence = this.computeConfidence(scores, primaryAction);
    const aggressionLevel = this.computeAggressionLevel(snapshot, profile, strategy, prediction);

    const frame: DecisionFrame = { scores, primaryAction, confidence, tick, aggressionLevel };
    this.lastFrame = frame;
    return frame;
  }

  getLast(): DecisionFrame | null {
    return this.lastFrame;
  }

  private computeScores(
    snap: CombatSnapshot,
    profile: EnemyProfile,
    strategy: CombatStrategy,
    pred: PredictionFrame,
  ): ActionScore {
    const healthRatio = snap.botHealth / 20;
    const isLowHealth = healthRatio < this.config.retreatHealthThreshold;
    const inRange = snap.inRange;
    const cooldownRatio = Math.max(0, snap.ticksToNextAttack / 10);

    const attackBase = inRange ? 0.85 : 0.05;
    const attackCooldownPenalty = cooldownRatio * 0.55;
    const attackHitBonus = pred.hitChanceEstimate * 0.3;
    const attackWindowBonus = pred.isComboWindowOpen ? 0.15 : 0;
    const attackExposureBonus = pred.exposureScore * 0.2;
    const attackAggressionBonus = this.config.aggressionBias * 0.2;
    const attackLowHealthPenalty = isLowHealth ? 0.3 : 0;
    const attack = clamp(
      attackBase -
        attackCooldownPenalty +
        attackHitBonus +
        attackWindowBonus +
        attackExposureBonus +
        attackAggressionBonus -
        attackLowHealthPenalty,
      0,
      1,
    );

    const retreatLowHealth = isLowHealth ? 0.5 + this.config.defensiveBias * 0.4 : 0;
    const retreatIncoming = snap.incomingProjectiles.length > 0 ? 0.35 : 0;
    const retreatThreatBonus = snap.threatLevel === 'critical' ? 0.4 : snap.threatLevel === 'high' ? 0.2 : 0;
    const retreatFleeing = pred.isFleeingLikely ? 0.2 : 0;
    const retreat = clamp(retreatLowHealth + retreatIncoming + retreatThreatBonus + retreatFleeing, 0, 1);

    const counterDir = strategy.counterStrafeDir;
    const leftPredBase = pred.strafeDirectionProbability.right > 0.5 ? 0.65 : 0.3;
    const rightPredBase = pred.strafeDirectionProbability.left > 0.5 ? 0.65 : 0.3;
    const strafeLeftForced = counterDir === 'left' ? 0.25 : 0;
    const strafeRightForced = counterDir === 'right' ? 0.25 : 0;
    const strafePenaltyRetreat = retreat * 0.4;
    const strafeLeft = inRange ? clamp(leftPredBase + strafeLeftForced - strafePenaltyRetreat, 0, 1) : 0.05;
    const strafeRight = inRange ? clamp(rightPredBase + strafeRightForced - strafePenaltyRetreat, 0, 1) : 0.05;

    const blockIncoming = snap.incomingProjectiles.length > 0 ? 0.8 : 0;
    const blockProfile = profile.blockingRatio > 0.4 ? 0.15 : 0;
    const blockLowHealth = isLowHealth ? 0.25 : 0;
    const block = clamp(blockIncoming + blockProfile + blockLowHealth, 0, 1);

    const critWindowBonus = pred.criticalWindowOpen ? 0.6 : 0;
    const critFallingBonus = snap.verticalVelocity < -0.25 ? 0.5 : 0;
    const critGroundPenalty = snap.isOnGround ? -0.1 : 0.3;
    const criticalSetup = inRange ? clamp(critWindowBonus + critFallingBonus + critGroundPenalty, 0, 1) : 0;

    const wTapComboBonus = snap.comboActive ? 0.55 : 0.15;
    const wTapKbPriority = strategy.prioritiseKb ? 0.3 : 0;
    const wTapProfileBonus = profile.aggressionScore > 0.6 ? 0.1 : 0;
    const wTap = clamp(wTapComboBonus + wTapKbPriority + wTapProfileBonus, 0, 1);

    const track = inRange ? 0.95 : 0.6;

    return { attack, retreat, strafeLeft, strafeRight, block, criticalSetup, wTap, track };
  }

  private selectPrimary(scores: ActionScore): keyof ActionScore {
    let best: keyof ActionScore = 'attack';
    let bestScore = -Infinity;
    for (const key of Object.keys(scores) as Array<keyof ActionScore>) {
      const v = scores[key];
      if (v > bestScore) {
        bestScore = v;
        best = key;
      }
    }
    return best;
  }

  private computeConfidence(scores: ActionScore, primary: keyof ActionScore): number {
    const primaryScore = scores[primary];
    let maxOther = 0;
    for (const key of Object.keys(scores) as Array<keyof ActionScore>) {
      if (key !== primary && scores[key] > maxOther) maxOther = scores[key];
    }
    return clamp(primaryScore - maxOther + 0.5, 0, 1);
  }

  private computeAggressionLevel(
    snap: CombatSnapshot,
    profile: EnemyProfile,
    strategy: CombatStrategy,
    pred: PredictionFrame,
  ): number {
    const healthFactor = clamp(snap.botHealth / 20, 0, 1);
    const comboPressure = snap.comboActive ? 0.2 : 0;
    const profileAggression = strategy.aggressionLevel;
    const hitChanceFactor = pred.hitChanceEstimate * 0.3;
    const predictionFactor = pred.exposureScore * 0.2;
    const staggerBonus = profile.staggerFrequency > 0.5 ? 0.1 : 0;
    const raw =
      healthFactor * 0.3 +
      profileAggression * 0.25 +
      comboPressure +
      hitChanceFactor +
      predictionFactor +
      staggerBonus +
      this.config.aggressionBias * 0.15;
    return clamp(sigmoid((raw - 0.5) * 6), 0, 1);
  }

  private defaultFrame(tick: number): DecisionFrame {
    return {
      scores: {
        attack: 0.7,
        retreat: 0.1,
        strafeLeft: 0.45,
        strafeRight: 0.45,
        block: 0.1,
        criticalSetup: 0.3,
        wTap: 0.25,
        track: 0.85,
      },
      primaryAction: 'attack',
      confidence: 0.5,
      tick,
      aggressionLevel: 0.6,
    };
  }
}
