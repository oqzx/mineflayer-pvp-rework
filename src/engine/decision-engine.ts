import type { CombatSnapshot } from '../core/combat-state.js';
import type { EnemyProfile } from '../adaptation/session-memory.js';
import type { CombatStrategy } from '../adaptation/style-adapter.js';
import type { PredictionFrame } from './prediction-layer.js';
import type { DecisionEngineConfig } from '../config/types.js';
import type { IDecisionAgent } from './agent-interface.js';

export type { IDecisionAgent };

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

export class DecisionEngine implements IDecisionAgent {
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

    const attack = clamp(
      (inRange ? 0.85 : 0.05)
        - cooldownRatio * 0.55
        + pred.hitChanceEstimate * 0.3
        + (pred.isComboWindowOpen ? 0.15 : 0)
        + pred.exposureScore * 0.2
        + this.config.aggressionBias * 0.2
        - (isLowHealth ? 0.3 : 0),
      0, 1,
    );

    const retreat = clamp(
      (isLowHealth ? 0.5 + this.config.defensiveBias * 0.4 : 0)
        + (snap.incomingProjectiles.length > 0 ? 0.35 : 0)
        + (snap.threatLevel === 'critical' ? 0.4 : snap.threatLevel === 'high' ? 0.2 : 0)
        + (pred.isFleeingLikely ? 0.2 : 0),
      0, 1,
    );

    const strafePenalty = retreat * 0.4;
    const counterDir = strategy.counterStrafeDir;
    const strafeLeft = inRange
      ? clamp(
          (pred.strafeDirectionProbability.right > 0.5 ? 0.65 : 0.3)
            + (counterDir === 'left' ? 0.25 : 0)
            - strafePenalty,
          0, 1,
        )
      : 0.05;
    const strafeRight = inRange
      ? clamp(
          (pred.strafeDirectionProbability.left > 0.5 ? 0.65 : 0.3)
            + (counterDir === 'right' ? 0.25 : 0)
            - strafePenalty,
          0, 1,
        )
      : 0.05;

    const block = clamp(
      (snap.incomingProjectiles.length > 0 ? 0.8 : 0)
        + (profile.blockingRatio > 0.4 ? 0.15 : 0)
        + (isLowHealth ? 0.25 : 0),
      0, 1,
    );

    const criticalSetup = inRange
      ? clamp(
          (pred.criticalWindowOpen ? 0.6 : 0)
            + (snap.verticalVelocity < -0.25 ? 0.5 : 0)
            + (snap.isOnGround ? -0.1 : 0.3),
          0, 1,
        )
      : 0;

    const wTap = clamp(
      (snap.comboActive ? 0.55 : 0.15)
        + (strategy.prioritiseKb ? 0.3 : 0)
        + (profile.aggressionScore > 0.6 ? 0.1 : 0),
      0, 1,
    );

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
    const raw =
      clamp(snap.botHealth / 20, 0, 1) * 0.3
        + strategy.aggressionLevel * 0.25
        + (snap.comboActive ? 0.2 : 0)
        + pred.hitChanceEstimate * 0.3
        + pred.exposureScore * 0.2
        + (profile.staggerFrequency > 0.5 ? 0.1 : 0)
        + this.config.aggressionBias * 0.15;
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
