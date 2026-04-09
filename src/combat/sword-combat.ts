import { EventEmitter } from 'events'
import { AABBUtils } from '@nxg-org/mineflayer-util-plugin'
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Item } from 'prismarine-item'
import { Vec3 } from 'vec3'
import type { FullConfig } from '../config/types.js'
import type { CombatSnapshot } from '../core/combat-state.js'
import { performAttack } from '../util/attack.js'
import {
  humanDelay,
  shouldTrigger,
  microSaccade,
  eyeHeightJitter,
  focusLapseCheck,
  overshootAngle,
  humanizedCps,
} from '../util/humanizer.js'
import { FittsAimTracker } from '../util/fitts-aim.js'
import { CpsController } from './cps-controller.js'
import { AttackDebugger } from './attack-debugger.js'
import { ComboTracker } from './combo-tracker.js'
import { StrafeController } from '../movement/strafe-controller.js'
import { WTapController } from '../movement/w-tap-controller.js'
import { CriticalHandler } from '../tactics/critical-handler.js'
import { BlockHitHandler } from '../tactics/block-hit.js'
import { ShieldManager } from '../tactics/shield-manager.js'
import { HeightAdvantage } from '../tactics/height-advantage.js'
import { SessionMemory } from '../adaptation/session-memory.js'
import { StyleAdapter } from '../adaptation/style-adapter.js'
import type { CombatStrategy } from '../adaptation/style-adapter.js'
import { DecisionEngine } from '../engine/decision-engine.js'
import type { IDecisionAgent } from '../engine/agent-interface.js'
import { PredictionLayer } from '../engine/prediction-layer.js'
import type { PredictionFrame } from '../engine/prediction-layer.js'
import { BehaviorBlend } from '../engine/behavior-blend.js'
import type { BlendWeights } from '../engine/behavior-blend.js'
import { FatigueManager } from '../engine/fatigue-manager.js'
import 'mineflayer-pathfinder'
import { FollowGoal } from '../util/follow-goal.js'
import type { goals } from 'mineflayer-pathfinder'

const { getEntityAABB } = AABBUtils

const PI_HALF = Math.PI / 2
const DEBUG_ATTACK_SKIPS = false

type BotWithPathfinder = Bot & {
  pathfinder: {
    goal: goals.Goal | null
    setGoal(goal: goals.Goal | null, dynamic?: boolean): void
    stop(): void
    isMoving(): boolean
  }
}

export class SwordCombat extends EventEmitter {
  public target: Entity | undefined = undefined
  public lastTarget: Entity | undefined = undefined
  public wasInRange = false
  public wasVisible = false
  public ticksToNextAttack = 0
  public ticksSinceTargetAttack = 0
  public ticksSinceLastHurt = 0
  public ticksSinceLastTargetHit = 0
  public ticksSinceLastSwitch = 0
  public ticksSinceLastTargetHurt = 999
  public weaponOfChoice = 'sword'

  private readonly cps: CpsController
  private readonly attackDebug: AttackDebugger
  private readonly combo: ComboTracker
  private readonly strafe: StrafeController
  private readonly wtap: WTapController
  private readonly crits: CriticalHandler
  private readonly blockHit: BlockHitHandler
  private readonly shield: ShieldManager
  private readonly height: HeightAdvantage
  private readonly memory: SessionMemory
  private readonly adapter: StyleAdapter
  private readonly decisionEngine: IDecisionAgent
  private readonly predictionLayer: PredictionLayer
  private readonly behaviorBlend: BehaviorBlend
  private readonly fatigueManager: FatigueManager
  private readonly fittsTracker: FittsAimTracker

  private willBeFirstHit = true
  private followGoal: goals.Goal | undefined = undefined
  private followGoalTargetId: number | undefined = undefined
  private lastHealth = 20
  private currentTick = 0
  private lookAwayTicksLeft = 0
  private overshootRecovering = false
  private kbCounterTicksLeft = 0
  private shieldReequipArmed = false
  private shieldReactivateAtTick: number | null = null

  constructor(
    public readonly bot: Bot,
    public readonly config: FullConfig,
    agent?: IDecisionAgent,
  ) {
    super()
    this.cps = new CpsController(config.cps)
    this.attackDebug = new AttackDebugger(DEBUG_ATTACK_SKIPS)
    this.combo = new ComboTracker(config.wTap.everyHits, config.blockHit.everyHits)
    this.strafe = new StrafeController(config.strafe)
    this.wtap = new WTapController()
    this.crits = new CriticalHandler(config.critical)
    this.blockHit = new BlockHitHandler(config.blockHit, config.lowHealth)
    this.shield = new ShieldManager(config.shield)
    this.height = new HeightAdvantage()
    this.memory = new SessionMemory()
    this.adapter = new StyleAdapter(config.adaptation)
    this.decisionEngine = agent ?? new DecisionEngine(config.decisionEngine)
    this.predictionLayer = new PredictionLayer(config.prediction)
    this.behaviorBlend = new BehaviorBlend(config.behaviorBlend)
    this.fatigueManager = new FatigueManager(config.fatigue)
    this.fittsTracker = new FittsAimTracker()

    this.bot.on('physicsTick', this.onTick)
    this.bot.on('entitySwingArm', this.onTargetSwing)
    this.bot.on('health', this.onHealthChange)
    this.bot.on('entityHurt', this.onTargetHurt)
    this.bot.on('entityDead', this.onEntityGone)
    this.bot.on('entityGone', this.onEntityGone)
  }

  async engage(target: Entity): Promise<void> {
    if (target.id === this.target?.id) return
    this.stop()
    this.target = target
    this.ticksToNextAttack = 0
    this.ticksSinceLastTargetHurt = 999
    this.willBeFirstHit = true
    this.kbCounterTicksLeft = 0
    this.fittsTracker.reset()
    this.bot.tracker.trackEntity(target)
    this.bot.tracker.trackEntity(this.bot.entity)
    await this.equipBestWeapon()
    this.fatigueManager.reset()
    this.behaviorBlend.reset()
    this.emit('startedAttacking', target)
  }

  stop(): void {
    if (!this.target) return
    this.bot.tracker.stopTrackingEntity(this.target)
    this.lastTarget = this.target
    this.target = undefined
    this.kbCounterTicksLeft = 0
    this.shieldReequipArmed = false
    this.shieldReactivateAtTick = null
    this.fittsTracker.reset()
    this.combo.reset()
    this.cps.resetHitStreak()
    this.strafe.clearDir(this.bot)
    this.stopFollow()
    this.bot.clearControlStates()
    this.emit('stoppedAttacking')
  }

  async equipBestWeapon(): Promise<void> {
    const weapon = this.findWeapon()
    if (weapon) await this.equip(weapon)
  }

  botReach(): number {
    if (!this.target) return 10000
    const eyePos = this.bot.entity.position.offset(0, this.bot.entity.height * 0.9, 0)
    return getEntityAABB(this.target).distanceToVec(eyePos)
  }

  targetReach(): number {
    if (!this.target) return 10000
    const eyePos = this.target.position.offset(0, this.target.height * 0.9, 0)
    return getEntityAABB(this.bot.entity).distanceToVec(eyePos)
  }

  buildSnapshot(_tick: number): Partial<CombatSnapshot> {
    return {
      inRange: this.wasInRange,
      visible: this.wasVisible,
      comboActive: this.combo.state === 'combo',
      ticksSinceHurt: this.ticksSinceLastHurt,
      ticksSinceTargetHurt: this.ticksSinceLastTargetHurt,
      ticksSinceLastHit: this.ticksSinceLastTargetHit,
      ticksToNextAttack: this.ticksToNextAttack,
      isOnGround: this.bot.entity.onGround,
      verticalVelocity: this.bot.entity.velocity.y,
      botHealth: this.bot.health ?? 20,
    }
  }

  private debugSnapshot(cpsState = this.cps.getDebugState(this.currentTick)) {
    return {
      target: this.target,
      phase: this.combo.state,
      inRange: this.wasInRange,
      visible: this.wasVisible,
      ticksToNextAttack: this.ticksToNextAttack,
      age: this.bot.time.age,
      cpsElapsedTicks: cpsState.elapsedTicks,
      cpsNextIntervalTicks: cpsState.nextIntervalTicks,
      cpsReadyInTicks: cpsState.readyInTicks,
      intendedCps: cpsState.intendedCps,
    }
  }

  private onTick = (): void => {
    if (!this.target) return
    this.currentTick++
    this.ticksToNextAttack--
    this.ticksSinceTargetAttack++
    this.ticksSinceLastHurt++
    this.ticksSinceLastTargetHit++
    this.ticksSinceLastSwitch++
    this.ticksSinceLastTargetHurt++

    this.combo.update(this.ticksSinceLastHurt, this.ticksSinceLastTargetHit)
    this.processShieldReactivate()

    const profile = this.memory.getOrCreate(this.target.id)
    const strategy = this.adapter.deriveStrategy(profile)
    const predFrame = this.predictionLayer.update(
      this.target,
      this.bot.entity.position,
      this.currentTick,
      profile,
    )

    const partialSnapshot = this.buildSnapshot(this.currentTick)
    const fullSnapshot = this.buildFullSnapshot(partialSnapshot, predFrame)

    const decisionFrame = this.decisionEngine.evaluate(
      fullSnapshot,
      profile,
      strategy,
      predFrame,
      this.currentTick,
    )

    const fatigueModifiers = this.fatigueManager.update(!!this.target)
    const blendWeights = this.behaviorBlend.compute(
      decisionFrame,
      fullSnapshot,
      fatigueModifiers.cpsMultiplier,
    )

    this.memory.updatePredictability(this.target.id)

    this.checkRange()
    this.checkVisibility()
    this.rotate(predFrame)
    this.doMove(strategy, blendWeights)
    this.doStrafe(strategy, blendWeights, fatigueModifiers.strafeFrequencyMultiplier)
    void this.height.seekWithJumpBoost(
      this.bot,
      this.target,
      true,
      this.config.jumpBoost.useForHeightAdvantage,
    )
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.checkShieldDisable().catch(() => {})
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.handleCrits().catch(() => {})
    this.handleShieldToggle()

    if (this.kbCounterTicksLeft > 0) {
      this.kbCounterTicksLeft--
      this.bot.setControlState('back', false)
      this.bot.setControlState('forward', true)
      this.bot.setControlState('sprint', true)
    }

    if (this.ticksToNextAttack > -1) {
      this.attackDebug.skip('local_cooldown_gate', this.debugSnapshot())
      return
    }

    if (this.shield.isOverrideActive) {
      this.attackDebug.skip('shield_override_active', this.debugSnapshot())
      return
    }

    if (this.bot.entity.velocity.y <= -0.25) this.bot.setControlState('sprint', false)
    if (
      this.bot.entity.onGround &&
      this.config.wTap.enabled &&
      blendWeights.wTapWeight > 0.35 &&
      this.combo.shouldWTap()
    ) {
      void this.wtap.wtap(this.bot)
    }

    const shouldHit = this.shouldHitSelect(predFrame)
    if (!shouldHit) return

    const cpsStateBefore = this.cps.getDebugState(this.currentTick)
    const cpsReady = this.cps.shouldAttack(
      this.currentTick,
      this.combo.state === 'combo' ? 'combo' : 'engaging',
      fatigueModifiers.cpsMultiplier,
    )
    if (!cpsReady) {
      this.attackDebug.skip('cps_controller_gate', this.debugSnapshot(cpsStateBefore), {
        age: this.currentTick,
        fatigueMultiplier: fatigueModifiers.cpsMultiplier.toFixed(3),
      })
      return
    }

    if (blendWeights.attackWeight <= 0.2) {
      this.attackDebug.skip('blend_weight_gate', this.debugSnapshot(), {
        attackWeight: blendWeights.attackWeight.toFixed(3),
      })
      return
    }

    void this.attemptAttack()
  }

  private buildFullSnapshot(
    partial: Partial<CombatSnapshot>,
    predFrame: PredictionFrame,
  ): CombatSnapshot {
    return {
      phase: 'engaging',
      target: this.target,
      targets: [],
      threatLevel: 'low',
      incomingProjectiles: [],
      aimingEntities: [],
      tick: this.currentTick,
      botHealth: this.bot.health ?? 20,
      targetHealth: undefined,
      inRange: partial.inRange ?? false,
      visible: partial.visible ?? false,
      comboActive: partial.comboActive ?? false,
      ticksSinceHurt: partial.ticksSinceHurt ?? 999,
      ticksSinceTargetHurt: partial.ticksSinceTargetHurt ?? 999,
      ticksSinceLastHit: partial.ticksSinceLastHit ?? 999,
      ticksToNextAttack: partial.ticksToNextAttack ?? 0,
      isOnGround: partial.isOnGround ?? true,
      verticalVelocity: partial.verticalVelocity ?? 0,
      predictedTargetPosition: predFrame.predictedPosition,
    }
  }

  private async handleCrits(): Promise<void> {
    if (!this.target) return
    const inWater = (this.bot.entity as unknown as { isInWater: boolean }).isInWater
    if (
      !this.crits.shouldAttemptCrit(
        this.ticksToNextAttack,
        this.bot.entity.onGround,
        this.wasInRange,
        inWater,
      )
    )
      return
    await this.crits.executeCrit(this.bot, this.ticksToNextAttack)
  }

  private async checkShieldDisable(): Promise<void> {
    if (!this.target || this.bot.supportFeature('doesntHaveOffHandSlot')) return
    if (this.ticksSinceLastSwitch < 3 || this.ticksSinceTargetAttack < 3) return
    await this.shield.tryDisableShield(this.bot, this.target, (w) => this.equip(w))
  }

  private handleShieldToggle(): void {
    if (this.ticksToNextAttack !== 0 || !this.wasInRange || !this.wasVisible) return
    if (this.shield.isEquipped(this.bot) && this.config.shield.mode === 'legit') {
      this.bot.deactivateItem()
    }
    this.shieldReequipArmed = true
  }

  private processShieldReactivate(): void {
    if (this.shieldReactivateAtTick === null || this.currentTick < this.shieldReactivateAtTick)
      return

    this.shieldReactivateAtTick = null
    if (this.shield.isEquipped(this.bot)) {
      this.bot.activateItem(true)
    }
  }

  private doMove(strategy: CombatStrategy, blend: BlendWeights): void {
    if (!this.target) {
      this.bot.clearControlStates()
      return
    }

    const farAway = this.botReach() >= this.config.generic.attackRange
    if (farAway) {
      this.startFollow()
      return
    }

    this.stopFollow()

    const isLow = (this.bot.health ?? 20) <= this.config.lowHealth.threshold

    // Gap logic — run away first, eat, re-equip sword
    const retreatDriven = blend.retreatWeight > 0.5
    let shouldApproach = !isLow || !this.config.lowHealth.preferBlockOverAttack
    if (retreatDriven) shouldApproach = false

    const tooClose = this.botReach() > this.config.generic.tooCloseRange
    shouldApproach = shouldApproach && tooClose

    if (
      shouldTrigger(this.config.humanization.sprintToggleNoiseProbability * 0.5) &&
      shouldApproach
    ) {
      shouldApproach = false
    }

    if (!this.bot.getControlState('back')) {
      this.bot.setControlState('forward', shouldApproach)
      this.bot.setControlState('sprint', shouldApproach)
    }
  }

  private doStrafe(strategy: CombatStrategy, blend: BlendWeights, fatigueMultiplier: number): void {
    if (!this.target) {
      this.strafe.clearDir(this.bot)
      return
    }
    if (blend.strafeWeight < 0.15) {
      this.strafe.clearDir(this.bot)
      return
    }
    const forced = strategy.counterStrafeDir !== 'none' ? strategy.counterStrafeDir : undefined
    this.strafe.update(
      this.bot,
      this.target,
      this.botReach(),
      this.config.generic.attackRange,
      forced,
      fatigueMultiplier,
    )
  }

  private checkRange(): void {
    if (!this.target) return
    const dist = this.target.position.distanceTo(this.bot.entity.position)
    if (dist > this.config.generic.viewDistance) {
      this.stop()
      return
    }
    const inRange = this.botReach() <= this.config.generic.attackRange
    if (!this.wasInRange && inRange && this.config.strafe.mode === 'circle') {
      this.ticksToNextAttack = -1
    }
    this.wasInRange = inRange
  }

  private checkVisibility(): void {
    if (!this.target) return
    const bb0 = getEntityAABB(this.bot.entity)
    const bb1 = getEntityAABB(this.target)
    if (bb0.intersects(bb1)) {
      this.wasVisible = true
      return
    }

    const eyePos = this.bot.entity.position.offset(0, this.bot.entity.height * 0.9, 0)
    const eyeDir = this.bot.util.getViewDir()
    const reach = this.config.generic.attackRange
    const hit = this.bot.util.raytrace.entityRaytrace(
      eyePos,
      eyeDir,
      reach,
      (e: Entity) => e.id === this.target?.id,
    )
    if (hit === this.target) {
      this.wasVisible = true
      return
    }

    const feet = this.target.position.offset(0, 0.1, 0)
    const dirToFeet = feet.minus(eyePos).normalize()
    const hitFeet = this.bot.util.raytrace.entityRaytrace(
      eyePos,
      dirToFeet,
      reach,
      (e: Entity) => e.id === this.target?.id,
    )
    this.wasVisible = hitFeet === this.target
  }

  private rotate(predFrame: PredictionFrame): void {
    if (!this.config.rotate.enabled || !this.target) return
    if (!this.config.rotate.lookAtHidden && !this.wasVisible) return

    const rotateCfg = this.config.rotate
    const humanCfg = this.config.humanization

    if (this.lookAwayTicksLeft > 0) {
      this.lookAwayTicksLeft--
      return
    }

    const lapseCheck = focusLapseCheck(
      rotateCfg.lookAwayProbability,
      rotateCfg.lookAwayDurationTicks,
    )
    if (lapseCheck.lapseOccurs) {
      this.lookAwayTicksLeft = lapseCheck.durationTicks
      return
    }

    const botEye = this.bot.entity.position.offset(0, this.bot.entity.height * 0.9, 0)

    const fittsPoint = this.fittsTracker.computeAimPoint(
      botEye,
      this.bot.entity.yaw,
      this.target,
      rotateCfg.fittsBias,
    )

    const useLeadAim = rotateCfg.mode === 'constant' || this.ticksToNextAttack <= 0
    const leadPos = predFrame.predictedPosition

    const aimTarget = useLeadAim
      ? new Vec3(
          leadPos.x * 0.65 + fittsPoint.x * 0.35,
          fittsPoint.y,
          leadPos.z * 0.65 + fittsPoint.z * 0.35,
        )
      : fittsPoint

    const aimWithVerticalJitter = aimTarget.offset(
      0,
      eyeHeightJitter(0, humanCfg.eyeHeightVarianceFactor),
      0,
    )

    const dx = aimWithVerticalJitter.x - botEye.x
    const dy = aimWithVerticalJitter.y - botEye.y
    const dz = aimWithVerticalJitter.z - botEye.z
    const groundDist = Math.sqrt(dx * dx + dz * dz)

    let targetYaw = Math.atan2(-dx, -dz)
    let targetPitch = groundDist > 0 ? Math.atan2(dy, groundDist) : 0

    if (rotateCfg.overshootEnabled && !this.overshootRecovering && this.ticksToNextAttack === -1) {
      const result = overshootAngle(
        this.bot.entity.yaw,
        targetYaw,
        rotateCfg.overshootAmplitude,
        rotateCfg.overshootRecoveryFactor,
      )
      targetYaw = result.value
      this.overshootRecovering = result.recovering
    } else {
      this.overshootRecovering = false
    }

    if (shouldTrigger(rotateCfg.microSaccadeFrequency)) {
      const saccade = microSaccade(rotateCfg.microSaccadeAmplitude)
      targetYaw += saccade.yawDelta
      targetPitch += saccade.pitchDelta
    }

    targetPitch = Math.max(-PI_HALF, Math.min(PI_HALF, targetPitch))

    const force = !rotateCfg.smooth

    if (rotateCfg.mode === 'constant' || this.ticksToNextAttack === -1) {
      void this.bot.look(targetYaw, targetPitch, force)
    } else if (rotateCfg.mode === 'legit') {
      if (predFrame.isComboWindowOpen || predFrame.hitChanceEstimate > 0.6) {
        void this.bot.look(targetYaw, targetPitch, false)
      }
    }
  }

  private shouldHitSelect(predFrame: PredictionFrame): boolean {
    if (!this.target) {
      this.attackDebug.skip('missing_target', this.debugSnapshot())
      return false
    }
    if (!this.wasInRange) {
      this.attackDebug.skip('out_of_range', this.debugSnapshot(), {
        botReach: this.botReach().toFixed(3),
        attackRange: this.config.generic.attackRange.toFixed(3),
      })
      return false
    }
    if (!this.config.generic.hitThroughWalls && !this.wasVisible) {
      this.attackDebug.skip('not_visible', this.debugSnapshot())
      return false
    }
    if (!this.bot.supportFeature('doesntHaveOffHandSlot') && this.ticksToNextAttack > -1) {
      this.attackDebug.skip('offhand_cooldown_gate', this.debugSnapshot())
      return false
    }

    if (this.config.generic.respectIframes) {
      const iframeProbability = this.computeIframeProbability(this.ticksSinceLastTargetHurt)
      const iframeRoll = Math.random()
      if (iframeRoll >= iframeProbability) {
        this.attackDebug.skip('iframe_probability_gate', this.debugSnapshot(), {
          iframeProbability: iframeProbability.toFixed(3),
          iframeRoll: iframeRoll.toFixed(3),
          ticksSinceTargetHurt: this.ticksSinceLastTargetHurt,
        })
        return false
      }
    }

    const chargeCheck = this.computeChargeProbability(this.ticksToNextAttack)
    const chargeRoll = Math.random()
    if (chargeRoll >= chargeCheck) {
      this.attackDebug.skip('charge_probability_gate', this.debugSnapshot(), {
        chargeProbability: chargeCheck.toFixed(3),
        chargeRoll: chargeRoll.toFixed(3),
      })
      return false
    }

    const hitChanceBonus = predFrame.hitChanceEstimate > 0.5 ? 0.25 : 0.1
    const exposureBonus = predFrame.exposureScore > 0.6 ? 0.2 : 0.05
    const comboBonus = this.combo.state === 'combo' ? 0.15 : 0
    const finalProbability = Math.min(1, 0.78 + hitChanceBonus + exposureBonus + comboBonus)
    const finalRoll = Math.random()
    if (finalRoll >= finalProbability) {
      this.attackDebug.skip('final_attack_probability_gate', this.debugSnapshot(), {
        finalProbability: finalProbability.toFixed(3),
        finalRoll: finalRoll.toFixed(3),
        hitChanceEstimate: predFrame.hitChanceEstimate.toFixed(3),
        exposureScore: predFrame.exposureScore.toFixed(3),
      })
      return false
    }
    return true
  }

  private computeIframeProbability(ticksSinceHurt: number): number {
    if (ticksSinceHurt <= 0) return 0
    return 1 / (1 + Math.exp(-0.9 * (ticksSinceHurt - 8)))
  }

  private computeChargeProbability(ticksToNext: number): number {
    if (ticksToNext > 2) return 0.05
    if (ticksToNext > 0) return 0.3
    const overdueTicks = Math.abs(Math.min(ticksToNext + 1, 0))
    return 1 - Math.exp(-0.9 * overdueTicks)
  }

  async attemptAttack(): Promise<void> {
    if (!this.target) {
      this.attackDebug.skip('attempt_attack_missing_target', this.debugSnapshot())
      return
    }
    if (!this.wasInRange) {
      this.willBeFirstHit = true
      this.attackDebug.skip('attempt_attack_out_of_range', this.debugSnapshot(), {
        botReach: this.botReach().toFixed(3),
      })
      return
    }
    if (!this.config.generic.hitThroughWalls && !this.wasVisible) {
      this.attackDebug.skip('attempt_attack_not_visible', this.debugSnapshot())
      return
    }

    if (this.config.generic.missChance > 0 && shouldTrigger(this.config.generic.missChance)) {
      this.attackDebug.skip('miss_chance_roll', this.debugSnapshot(), {
        missChance: this.config.generic.missChance.toFixed(3),
      })
      return
    }

    const humanCfg = this.config.humanization

    if (shouldTrigger(humanCfg.postHitPauseProbability) && !this.willBeFirstHit) {
      await humanDelay(humanCfg.postHitPauseDurationMs)
      if (!this.target) return
    } else {
      await humanDelay(humanCfg.reactionDelay)
      if (!this.target) return
    }

    const attackJitter = humanCfg.attackJitterMs
    if (attackJitter.max > 0 && shouldTrigger(0.4)) {
      const jitterMs = Math.random() * (attackJitter.max - attackJitter.min) + attackJitter.min
      if (jitterMs > 5) {
        await new Promise<void>((resolve) => setTimeout(resolve, jitterMs))
        if (!this.target) return
      }
    }

    if (
      !this.bot.entity.onGround &&
      this.bot.entity.velocity.y < -0.1 &&
      this.config.critical.enabled
    ) {
      await this.crits.reactionCrit(this.bot, this.ticksToNextAttack)
    }

    const target = this.target
    if (!target) return

    performAttack(this.bot, target)
    this.willBeFirstHit = false
    this.ticksSinceLastTargetHit = 0
    this.combo.recordHit()
    this.cps.recordHit()
    this.strafe.recordHit()

    // Block-hit: trigger after attacking, not when taking damage
    if (this.config.blockHit.enabled && this.combo.shouldBlockHit()) {
      void this.blockHit.execute(
        this.bot,
        !this.bot.supportFeature('doesntHaveOffHandSlot'),
        (this.bot.health ?? 20) <= this.config.lowHealth.threshold,
      )
    }

    const fromAbove = this.bot.entity.position.y > target.position.y + 0.3
    const reach = this.botReach()
    this.memory.recordAttack(
      target.id,
      this.bot.time.age,
      this.shield.isEquipped(this.bot),
      fromAbove,
      reach,
    )

    const heldItem = this.bot.heldItem
    const usedAxe = heldItem?.name.includes('_axe') ?? false
    const usedBow = heldItem?.name === 'bow' || heldItem?.name === 'crossbow'
    this.memory.recordBehavior(
      target.id,
      this.bot.time.age,
      false,
      usedBow,
      false,
      false,
      false,
      usedAxe,
    )

    const humanCps = humanizedCps(
      this.config.cps.max,
      this.config.humanization.cpsVarianceFactor,
      this.config.humanization.wristFatigueEnabled,
      this.config.humanization.wristFatigueCpsReduction,
    )
    const effectiveCps = Math.min(this.config.cps.max, humanCps)

    if (this.shieldReequipArmed) {
      this.shieldReequipArmed = false
      this.shieldReactivateAtTick = this.currentTick + 3
    }

    this.emit('attackedTarget', target)
    const held = this.bot.heldItem
    if (held) {
      const cooldown = Math.floor((1 / this.getAttackSpeed(held.name)) * 20)
      const cpsBasedInterval = Math.floor(20 / effectiveCps)
      this.ticksToNextAttack = Math.max(cooldown, cpsBasedInterval - 1)
      this.attackDebug.hit(this.debugSnapshot(), {
        weapon: held.name,
        weaponCooldownTicks: cooldown,
        cpsBasedIntervalTicks: cpsBasedInterval,
        effectiveCps: effectiveCps.toFixed(2),
        configuredMaxCps: this.config.cps.max,
      })
    } else {
      this.attackDebug.hit(this.debugSnapshot(), {
        weapon: 'none',
        effectiveCps: effectiveCps.toFixed(2),
        configuredMaxCps: this.config.cps.max,
      })
    }
  }

  private getAttackSpeed(name: string): number {
    const speeds: Record<string, number> = {
      sword: 1.7,
      axe: 0.9,
      pickaxe: 1.2,
      shovel: 1.1,
      hoe: 4.0,
    }
    for (const [key, val] of Object.entries(speeds)) {
      if (name.includes(key)) return val
    }
    return 4.0
  }

  findWeapon(name?: string): Item | null {
    const target = name ?? this.weaponOfChoice
    const held = this.bot.inventory.slots[this.bot.getEquipmentDestSlot('hand')]
    if (held?.name.includes(target)) return held
    return (
      this.bot.util.inv.getAllItems().find((i: Item | null) => i?.name.includes(target)) ?? null
    )
  }

  async equip(weapon: Item): Promise<boolean> {
    const held = this.bot.inventory.slots[this.bot.getEquipmentDestSlot('hand')]
    if (held?.name === weapon.name) return true
    return this.bot.util.inv.customEquip(weapon, 'hand')
  }

  private startFollow(): void {
    if (!this.target) return
    const pf = (this.bot as BotWithPathfinder).pathfinder
    if (!pf) return

    const isSameTargetGoal = this.followGoalTargetId === this.target.id
    if (!this.followGoal || !isSameTargetGoal) {
      this.stopFollow()
      const predictTicks = this.config.follow.predictive ? this.config.follow.predictTicks : 0
      this.followGoal = new FollowGoal(
        this.bot,
        this.target,
        this.config.follow.distance,
        predictTicks,
      )
      this.followGoalTargetId = this.target.id
    }

    // Re-issue the goal if pathfinder was stopped or replaced while our cached goal still exists.
    if (pf.goal !== this.followGoal) {
      pf.setGoal(this.followGoal, true)
    }
  }

  private stopFollow(): void {
    const pf = (this.bot as BotWithPathfinder).pathfinder
    if (pf?.goal && this.followGoal && pf.goal === this.followGoal) {
      pf.setGoal(null)
    } else if (pf && this.followGoal && pf.isMoving()) {
      pf.stop()
    }
    this.followGoal = undefined
    this.followGoalTargetId = undefined
  }

  private onTargetSwing = (entity: Entity): void => {
    if (entity === this.target) {
      this.ticksSinceTargetAttack = 0
      this.predictionLayer.recordEnemyAttack(this.currentTick)
    }
  }

  private onEntityGone = (entity: Entity): void => {
    if (this.target && entity.id === this.target.id) this.stop()
  }

  private onTargetHurt = (entity: Entity): void => {
    if (this.target && entity.id === this.target.id) {
      this.ticksSinceLastTargetHurt = 0
      this.memory.recordStagger(entity.id)
    }
  }

  private onHealthChange = (): void => {
    const hp = this.bot.health ?? 20
    if (hp >= this.lastHealth) {
      this.lastHealth = hp
      return
    }
    this.lastHealth = hp
    this.ticksSinceLastHurt = 0

    if (this.ticksSinceTargetAttack < 6) {
      this.ticksSinceLastTargetHit = 0
    }

    this.kbCounterTicksLeft = 3

    if (this.target) {
      const wasAggressive = this.ticksSinceTargetAttack < 8
      this.memory.recordPostHitBehavior(this.target.id, wasAggressive)
    }
  }
}
