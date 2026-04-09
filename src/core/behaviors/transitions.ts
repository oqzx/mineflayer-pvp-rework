import { getTransition } from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { PvpData } from '../pvp-data.js'
import { IdleBehavior } from './idle.js'
import { EngagingBehavior } from './engaging.js'
import { ComboBehavior } from './combo.js'
import { StunnedBehavior } from './stunned.js'
import { BackingOffBehavior } from './backing-off.js'
import { CriticalSetupBehavior } from './critical-setup.js'
import { RetreatBehavior } from './retreat.js'
import { BowCombatBehavior, canEnterBowCombat } from './bow-combat.js'
import { DodgeBehavior } from './dodge.js'
import { EatingBehavior } from './eating.js'
import { PearlingBehavior } from './pearling.js'
import { buildStuckTransitions } from './stuck/index.js'

type AnyState = { data: object; bot: Bot }
type PearlPlanType = 'defensive' | 'escape' | 'aggressive' | null

function pvp(s: AnyState): PvpData {
  return s.data as PvpData
}

function hasTarget(s: AnyState): boolean {
  return pvp(s).entity !== undefined
}

function isLowHealth(s: AnyState): boolean {
  return pvp(s).health.isLow
}

function hasInstantHealthReady(s: AnyState): boolean {
  const d = pvp(s)
  return (
    d.health.canAttemptInstantHealth() &&
    d.autoBuff.hasItemForBuff('instanthealth') &&
    !d.autoBuff.hasBuff('instanthealth')
  )
}

function shouldWaitForGroundedInstantHealth(s: AnyState): boolean {
  return hasInstantHealthReady(s) && !s.bot.entity.onGround
}

function canUseGapple(s: AnyState): boolean {
  const d = pvp(s)
  return d.gap.shouldEat(s.bot, d.snapshot.phase, d.snapshot.incomingProjectiles.length > 0)
}

function hasPearls(s: AnyState): boolean {
  return s.bot.inventory.items().some((i: { name: string }) => i.name === 'ender_pearl')
}

function pearlPlanType(s: AnyState, lowHealth = pvp(s).health.isLow): PearlPlanType {
  const d = pvp(s)
  return d.pearl.getPearlingPlanType(s.bot, d.entity, lowHealth)
}

function isEscapeOrDefensivePearl(planType: PearlPlanType): boolean {
  return planType === 'escape' || planType === 'defensive'
}

function canSurvivePearl(s: AnyState): boolean {
  return pvp(s).pearl.canSurvivePearl(s.bot)
}

function shouldPearlBeforeHealing(s: AnyState): boolean {
  if (!isLowHealth(s) || !hasTarget(s)) return false
  if (hasInstantHealthReady(s)) return false
  if (!canUseGapple(s)) return false
  if (!canSurvivePearl(s)) return false
  return isEscapeOrDefensivePearl(pearlPlanType(s, true))
}

function canEnterPearling(s: AnyState): boolean {
  const d = pvp(s)
  if (shouldWaitForGroundedInstantHealth(s)) return false
  if (d.health.isWaitingForInstantHealth()) return false

  const planType = pearlPlanType(s)
  if (isEscapeOrDefensivePearl(planType) && !canSurvivePearl(s)) return false
  if (planType === 'aggressive' && needsHeal(s)) return false
  return planType !== null
}

function needsHeal(s: AnyState): boolean {
  if (!isLowHealth(s)) return false
  if (pvp(s).health.isWaitingForInstantHealth()) return false
  if (shouldPearlBeforeHealing(s)) return false
  const hasHealthPotion = hasInstantHealthReady(s)
  if (shouldWaitForGroundedInstantHealth(s)) return false
  return canUseGapple(s) || hasHealthPotion
}

function shouldRetreat(s: AnyState): boolean {
  const d = pvp(s)
  if (!isLowHealth(s)) return false
  if (hasPearls(s) && d.config.pearl.enabled) return false
  if (hasInstantHealthReady(s)) return false
  if (d.gap.findGoldenApple(s.bot)) return false
  return d.health.isCritical || d.health.current <= d.config.lowHealth.threshold
}

function trackerPhase(s: AnyState): string {
  return pvp(s).pearl.getTrackerPhase(s.bot)
}

function shouldLogPearlTransition(s: AnyState, allowed: boolean): boolean {
  return allowed || trackerPhase(s) !== 'idle'
}

function horizontalDistanceToTarget(s: AnyState): number | null {
  const target = pvp(s).entity
  if (!target) return null
  const dx = target.position.x - s.bot.entity.position.x
  const dz = target.position.z - s.bot.entity.position.z
  return Math.sqrt(dx * dx + dz * dz)
}

function logPearlTransitionDecision(s: AnyState, allowed: boolean, reason: string): void {
  const d = pvp(s)
  const targetId = d.entity?.id ?? 'none'
  console.log(
    `[pearl-transition] tick=${d.tick} allowed=${allowed} reason=${reason} target=${targetId}`,
  )
}

export function buildTransitions() {
  const stuckTransitions = buildStuckTransitions(IdleBehavior)
  const MELEE = [
    EngagingBehavior,
    ComboBehavior,
    BackingOffBehavior,
    CriticalSetupBehavior,
    StunnedBehavior,
  ] as const

  const idleToEngaging = getTransition('idleToEngaging', IdleBehavior, EngagingBehavior)
    .setShouldTransition((s) => hasTarget(s))
    .build()

  const meleeToIdle = getTransition('meleeToIdle', [...MELEE], IdleBehavior)
    .setShouldTransition((s) => !hasTarget(s))
    .build()

  const engagingToCombo = getTransition('engagingToCombo', EngagingBehavior, ComboBehavior)
    .setShouldTransition((s) => {
      const snap = pvp(s).snapshot
      return !!pvp(s).entity && snap.inRange && snap.comboActive
    })
    .build()

  const comboToEngaging = getTransition('comboToEngaging', ComboBehavior, EngagingBehavior)
    .setShouldTransition((s) => !!pvp(s).entity && !pvp(s).snapshot.inRange)
    .build()

  const comboToStunned = getTransition('comboToStunned', ComboBehavior, StunnedBehavior)
    .setShouldTransition((s) => pvp(s).snapshot.ticksSinceHurt <= 3)
    .build()

  const stunnedToCombo = getTransition('stunnedToCombo', StunnedBehavior, ComboBehavior)
    .setShouldTransition((s) => pvp(s).snapshot.ticksSinceHurt > 10)
    .build()

  const meleeToRetreat = getTransition('meleeToRetreat', [...MELEE], RetreatBehavior)
    .setShouldTransition((s) => shouldRetreat(s))
    .build()

  const retreatToEngaging = getTransition('retreatToEngaging', RetreatBehavior, EngagingBehavior)
    .setShouldTransition((s) => !isLowHealth(s) && hasTarget(s))
    .build()

  const retreatToIdle = getTransition('retreatToIdle', RetreatBehavior, IdleBehavior)
    .setShouldTransition((s) => !isLowHealth(s) && !hasTarget(s))
    .build()

  const retreatToEating = getTransition('retreatToEating', RetreatBehavior, EatingBehavior)
    .setShouldTransition((s) => isLowHealth(s) && needsHeal(s))
    .build()

  const meleeToEating = getTransition('meleeToEating', [...MELEE], EatingBehavior)
    .setShouldTransition((s) => needsHeal(s))
    .build()

  const eatingToEngaging = getTransition('eatingToEngaging', EatingBehavior, EngagingBehavior)
    .setShouldTransition((s) => s.isFinished() && !!pvp(s).entity)
    .build()

  const eatingToIdle = getTransition('eatingToIdle', EatingBehavior, IdleBehavior)
    .setShouldTransition((s) => s.isFinished() && !pvp(s).entity)
    .build()

  const meleeToPearling = getTransition('meleeToPearling', [...MELEE], PearlingBehavior)
    .setShouldTransition((s) => {
      const allowed = canEnterPearling(s)
      if (shouldLogPearlTransition(s, allowed)) {
        const reason = pvp(s).pearl.getPearlingDecisionReason(s.bot, pvp(s).entity, isLowHealth(s))
        logPearlTransitionDecision(s, allowed, reason)
      }

      return allowed
    })
    .build()

  const pearlingToEngaging = getTransition('pearlingToEngaging', PearlingBehavior, EngagingBehavior)
    .setShouldTransition((s) => s.isFinished() && hasTarget(s) && !needsHeal(s))
    .build()

  const pearlingToIdle = getTransition('pearlingToIdle', PearlingBehavior, IdleBehavior)
    .setShouldTransition((s) => s.isFinished() && !hasTarget(s))
    .build()

  const pearlingToEating = getTransition('pearlingToEating', PearlingBehavior, EatingBehavior)
    .setShouldTransition((s) => s.isFinished() && hasTarget(s) && needsHeal(s))
    .build()

  const meleeToBow = getTransition('meleeToBow', [...MELEE], BowCombatBehavior)
    .setShouldTransition((s) => {
      const d = pvp(s)
      if (!canEnterBowCombat(d)) return false
      const hDist = horizontalDistanceToTarget(s) ?? 0
      const target = d.entity
      const vDelta = target ? target.position.y - s.bot.entity.position.y : 0
      return hDist > 10 || vDelta > 2.5
    })
    .build()

  const bowToEngaging = getTransition('bowToEngaging', BowCombatBehavior, EngagingBehavior)
    .setShouldTransition((s) => {
      const d = pvp(s)
      if (!d.entity) return false
      if (!canEnterBowCombat(d)) return true
      // Must mirror meleeToBow's conditions exactly — if either condition that
      // triggered bow combat is still true, stay in bow. Only switch back to
      // melee when BOTH conditions are false, otherwise we get a tight loop:
      //   meleeToBow  fires on vDelta > 2.5
      //   bowToEngaging fires on hDist <= 5  (no vDelta guard)  <- was the bug
      const hDist = horizontalDistanceToTarget(s) ?? Infinity
      const target = d.entity
      const vDelta = target ? target.position.y - s.bot.entity.position.y : 0
      return hDist <= 5 && vDelta <= 2.5
    })
    .build()

  const bowToIdle = getTransition('bowToIdle', BowCombatBehavior, IdleBehavior)
    .setShouldTransition((s) => !hasTarget(s))
    .build()

  const meleeToDodge = getTransition('meleeToDodge', [...MELEE], DodgeBehavior)
    .setShouldTransition((s) => {
      const d = pvp(s)
      // this is wrong
      if (d.aimingEntities.length === 0) return false
      const threat = d.aimingEntities[0]
      return threat !== undefined && threat.estimatedImpactTick - d.tick <= 4
    })
    .build()

  const dodgeToEngaging = getTransition('dodgeToEngaging', DodgeBehavior, EngagingBehavior)
    .setShouldTransition((s) => pvp(s).aimingEntities.length === 0 && hasTarget(s))
    .build()

  const dodgeToIdle = getTransition('dodgeToIdle', DodgeBehavior, IdleBehavior)
    .setShouldTransition((s) => pvp(s).aimingEntities.length === 0 && !hasTarget(s))
    .build()

  return [
    ...stuckTransitions,
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
    pearlingToEating,
    pearlingToEngaging,
    pearlingToIdle,
    meleeToBow,
    bowToEngaging,
    bowToIdle,
    meleeToDodge,
    dodgeToEngaging,
    dodgeToIdle,
  ]
}
