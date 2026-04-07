import { getTransition } from '@nxg-org/mineflayer-static-statemachine';
import type { PvpData } from '../pvp-data.js';
import { IdleBehavior } from './idle.js';
import { EngagingBehavior } from './engaging.js';
import { ComboBehavior } from './combo.js';
import { StunnedBehavior } from './stunned.js';
import { BackingOffBehavior } from './backing-off.js';
import { CriticalSetupBehavior } from './critical-setup.js';
import { RetreatBehavior } from './retreat.js';
import { BowCombatBehavior } from './bow-combat.js';
import { DodgeBehavior } from './dodge.js';
import { EatingBehavior } from './eating.js';
import { PearlingBehavior } from './pearling.js';
import type { StateBehavior } from '@nxg-org/mineflayer-static-statemachine';

type AnyState = { data: object; bot: import('mineflayer').Bot };

function pvp(s: AnyState): PvpData {
  return s.data as PvpData;
}

function needsHeal(s: AnyState): boolean {
  const d = pvp(s);
  if (!d.health.isLow) return false;
  const snap = d.snapshot;
  const hasGapple = d.gap.shouldEat(s.bot, snap.phase, snap.incomingProjectiles.length > 0);
  const hasHealthPotion = d.autoBuff.hasItemForBuff('instant health') && !d.autoBuff.hasBuff('instant health');
  return hasGapple || hasHealthPotion;
}

export function buildTransitions() {
  const MELEE = [EngagingBehavior, ComboBehavior, BackingOffBehavior, CriticalSetupBehavior, StunnedBehavior] as const;

  const idleToEngaging = getTransition('idleToEngaging', IdleBehavior, EngagingBehavior)
    .setShouldTransition((s) => pvp(s).entity !== undefined)
    .build();

  const meleeToIdle = getTransition('meleeToIdle', [...MELEE], IdleBehavior)
    .setShouldTransition((s) => pvp(s).entity === undefined)
    .build();

  const engagingToCombo = getTransition('engagingToCombo', EngagingBehavior, ComboBehavior)
    .setShouldTransition((s) => {
      const snap = pvp(s).snapshot;
      return !!pvp(s).entity && snap.inRange && snap.comboActive;
    })
    .build();

  const comboToEngaging = getTransition('comboToEngaging', ComboBehavior, EngagingBehavior)
    .setShouldTransition((s) => !!pvp(s).entity && !pvp(s).snapshot.inRange)
    .build();

  const comboToStunned = getTransition('comboToStunned', ComboBehavior, StunnedBehavior)
    .setShouldTransition((s) => pvp(s).snapshot.ticksSinceHurt <= 3)
    .build();

  const stunnedToCombo = getTransition('stunnedToCombo', StunnedBehavior, ComboBehavior)
    .setShouldTransition((s) => pvp(s).snapshot.ticksSinceHurt > 10)
    .build();

  const meleeToRetreat = getTransition('meleeToRetreat', [...MELEE], RetreatBehavior)
    .setShouldTransition((s) => pvp(s).health.isCritical)
    .build();

  const retreatToEngaging = getTransition('retreatToEngaging', RetreatBehavior, EngagingBehavior)
    .setShouldTransition((s) => !pvp(s).health.isLow && !!pvp(s).entity)
    .build();

  const retreatToIdle = getTransition('retreatToIdle', RetreatBehavior, IdleBehavior)
    .setShouldTransition((s) => !pvp(s).health.isLow && !pvp(s).entity)
    .build();

  const retreatToEating = getTransition('retreatToEating', RetreatBehavior, EatingBehavior)
    .setShouldTransition((s) => {
      const d = pvp(s);
      return d.health.isLow && needsHeal(s);
    })
    .build();

  const meleeToEating = getTransition('meleeToEating', [...MELEE], EatingBehavior)
    .setShouldTransition((s) => needsHeal(s))
    .build();

  const eatingToEngaging = getTransition('eatingToEngaging', EatingBehavior, EngagingBehavior)
    .setShouldTransition((s) => (s as unknown as EatingBehavior).isFinished() && !!pvp(s).entity)
    .build();

  const eatingToIdle = getTransition('eatingToIdle', EatingBehavior, IdleBehavior)
    .setShouldTransition((s) => (s as unknown as EatingBehavior).isFinished() && !pvp(s).entity)
    .build();

  const meleeToPearling = getTransition('meleeToPearling', [...MELEE], PearlingBehavior)
    .setShouldTransition((s) => {
      const d = pvp(s);
      if (!d.config.pearl.enabled || !s.bot.ender.hasPearls()) return false;
      const snap = d.snapshot;
      if (d.config.pearl.defensiveEnabled && snap.incomingProjectiles.length > 0) return true;
      if (!snap.inRange && d.entity) {
        return d.entity.position.distanceTo(s.bot.entity.position) > d.config.pearl.aggressiveRange;
      }
      return false;
    })
    .build();

  const pearlingToEngaging = getTransition('pearlingToEngaging', PearlingBehavior, EngagingBehavior)
    .setShouldTransition((s) => (s as unknown as PearlingBehavior).isFinished() && !!pvp(s).entity)
    .build();

  const pearlingToIdle = getTransition('pearlingToIdle', PearlingBehavior, IdleBehavior)
    .setShouldTransition((s) => (s as unknown as PearlingBehavior).isFinished() && !pvp(s).entity)
    .build();

  const meleeToBow = getTransition('meleeToBow', [...MELEE], BowCombatBehavior)
    .setShouldTransition((s) => {
      const d = pvp(s);
      if (!d.config.bow.enabled || !d.entity) return false;
      return d.entity.position.distanceTo(s.bot.entity.position) > d.config.generic.attackRange + 2;
    })
    .build();

  const bowToEngaging = getTransition('bowToEngaging', BowCombatBehavior, EngagingBehavior)
    .setShouldTransition((s) => {
      const d = pvp(s);
      if (!d.entity) return false;
      return d.entity.position.distanceTo(s.bot.entity.position) <= d.config.generic.attackRange + 1;
    })
    .build();

  const bowToIdle = getTransition('bowToIdle', BowCombatBehavior, IdleBehavior)
    .setShouldTransition((s) => !pvp(s).entity)
    .build();

  const meleeToDodge = getTransition('meleeToDodge', [...MELEE], DodgeBehavior)
    .setShouldTransition((s) => {
      const d = pvp(s);
      if (d.incomingProjectiles.length === 0) return false;
      const proj = d.incomingProjectiles[0];
      return proj !== undefined && proj.estimatedImpactTick - d.tick <= 4;
    })
    .build();

  const dodgeToEngaging = getTransition('dodgeToEngaging', DodgeBehavior, EngagingBehavior)
    .setShouldTransition((s) => pvp(s).incomingProjectiles.length === 0 && !!pvp(s).entity)
    .build();

  const dodgeToIdle = getTransition('dodgeToIdle', DodgeBehavior, IdleBehavior)
    .setShouldTransition((s) => pvp(s).incomingProjectiles.length === 0 && !pvp(s).entity)
    .build();

  return [
    idleToEngaging,
    meleeToIdle,
    engagingToCombo,
    comboToEngaging,
    comboToStunned,
    stunnedToCombo,
    meleeToRetreat,
    retreatToEngaging,
    retreatToIdle,
    retreatToEating,
    meleeToEating,
    eatingToEngaging,
    eatingToIdle,
    meleeToPearling,
    pearlingToEngaging,
    pearlingToIdle,
    meleeToBow,
    bowToEngaging,
    bowToIdle,
    meleeToDodge,
    dodgeToEngaging,
    dodgeToIdle,
  ];
}
