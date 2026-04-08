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
import { goals } from 'mineflayer-pathfinder'
import 'mineflayer-pathfinder'

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

class FollowGoal extends goals.Goal {
  private readonly rangeSq: number
  private cachedPos: Vec3

  constructor(
    private readonly bot: Bot,
    private readonly entity: Entity,
    range: number,
    private readonly predictTicks: number,
  ) {
    super()
    this.rangeSq = range * range
    this.cachedPos = entity.position.clone()
  }

  heuristic(n: { x: number; y: number; z: number }): number {
    const dx = Math.abs(this.cachedPos.x - n.x)
    const dy = Math.abs(this.cachedPos.y - n.y)
    const dz = Math.abs(this.cachedPos.z - n.z)
    return Math.abs(dx - dz) + Math.min(dx, dz) * Math.SQRT2 + dy
  }

  isEnd(n: { x: number; y: number; z: number }): boolean {
    const dx = this.cachedPos.x - n.x
    const dy = this.cachedPos.y - n.y
    const dz = this.cachedPos.z - n.z
    return dx * dx + dy * dy + dz * dz <= this.rangeSq
  }

  hasChanged(): boolean {
    type Tracker = { getEntitySpeed?: (e: Entity) => Vec3 | null }
    const vel = (this.bot.tracker as unknown as Tracker).getEntitySpeed?.(this.entity) ?? new Vec3(0, 0, 0)
    const predicted = this.entity.position.plus(vel.scaled(this.predictTicks))
    const dx = predicted.x - this.cachedPos.x
    const dy = predicted.y - this.cachedPos.y
    const dz = predicted.z - this.cachedPos.z
    if (dx * dx + dy * dy + dz * dz > 1) {
      this.cachedPos = predicted
      return true
    }
    return false
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
    const weapon = this.findWeapon()
    if (weapon) await this.equip(weapon)
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
    this.strafe.clearDir(this.bot)
    this.stopFollow()
    this.bot.clearControlStates()
    this.emit('stoppedAttacking')
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

    if (this.ticksSinceLastHurt <= 2) {
      this.ticksToNextAttack = -1
    }

    if (this.ticksToNextAttack > -1) {
      this.attackDebug.skip('local_cooldown_gate', this.debugSnapshot())
      return
    }

    if (this.shield.isOverrideActive) {
      this.attackDebug.skip('shield_override_active', this.debugSnapshot())
      return
    }

    if (this.bot.entity.velocity.y <= -0.25) {
      this.bot.setControlState('sprint', false)
    }

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

    if (blendWeights.attackWeight <= 0.3) {
      this.attackDebug.skip('blend_weight_gate', this.debugSnapshot(), {
        attackWeight: blendWeights.attackWeight.toFixed(3),
      })
      return
    }

    void this.attemptAttack()
  }

  private buildFullSnapshot(partial: Partial<CombatSnapshot>, predFrame: PredictionFrame): CombatSnapshot {
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
    if (this.shieldReactivateAtTick === null || this.currentTick < this.shieldReactivateAtTick) return
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

    if (this.combo.state === 'taking-damage') {
      if (isLow && this.config.lowHealth.extendedBlockEnabled) {
        void this.blockHit.executeExtended(this.bot)
      } else if (this.config.blockHit.enabled && this.combo.shouldBlockHit()) {
        void this.blockHit.execute(
          this.bot,
          !this.bot.supportFeature('doesntHaveOffHandSlot'),
          isLow,
        )
      }
    }

    const retreatDriven = blend.retreatWeight > 0.5
    let shouldApproach = !isLow || !this.config.lowHealth.preferBlockOverAttack

    if (this.ticksSinceLastHurt < 5 && this.kbCounterTicksLeft === 0) {
      shouldApproach = false
    }
    if (this.combo.state === 'combo' && !strategy.prioritiseKb) {
      shouldApproach = true
    }
    if (retreatDriven) {
      shouldApproach = false
    }

    this.bot.setControlState('forward', shouldApproach)
    this.bot.setControlState('back', !shouldApproach)
    this.bot.setControlState('sprint', shouldApproach && !this.shield.isEquipped(this.bot))
  }

  private doStrafe(strategy: CombatStrategy, blend: BlendWeights, freqMultiplier: number): void {
    if (!this.target) return
    const forcedDir = blend.strafeWeight > 0.5 ? (strategy.strafeDirection as 'left' | 'right') : undefined
    this.strafe.update(
      this.bot,
      this.target,
      this.botReach(),
      this.config.generic.attackRange,
      forcedDir,
      freqMultiplier,
      this.combo.state === 'combo' ? 1 : 0,
    )
  }

  private startFollow(): void {
    if (!this.target) return
    if (this.followGoalTargetId === this.target.id) return

    const botWithPathfinder = this.bot as BotWithPathfinder
    if (!botWithPathfinder.pathfinder) return

    this.stopFollow()
    const predictTicks = this.config.follow.predictive ? this.config.follow.predictTicks : 0
    this.followGoal = new FollowGoal(
      this.bot,
      this.target,
      this.config.follow.distance,
      predictTicks,
    )
    botWithPathfinder.pathfinder.setGoal(this.followGoal, true)
    this.followGoalTargetId = this.target.id
  }

  private stopFollow(): void {
    const botWithPathfinder = this.bot as BotWithPathfinder
    if (this.followGoalTargetId !== undefined) {
      botWithPathfinder.pathfinder?.stop()
      botWithPathfinder.pathfinder?.setGoal(null)
      this.followGoal = undefined
      this.followGoalTargetId = undefined
    }
  }

  private checkRange(): void {
    if (!this.target) {
      this.wasInRange = false
      return
    }
    const reach = this.botReach()
    this.wasInRange = reach <= this.config.generic.attackRange
  }

  private checkVisibility(): void {
    if (!this.target) {
      this.wasVisible = false
      return
    }
    this.wasVisible = this.bot.canSeeEntity(this.target)
  }

  private rotate(predFrame: PredictionFrame): void {
    if (!this.target) return

    const targetPos = predFrame.predictedPosition
    const aimPoint = targetPos.offset(0, this.target.height * 0.9, 0)

    const config = this.config.rotate
    if (!config.enabled) return

    const dx = aimPoint.x - this.bot.entity.position.x
    const dy = aimPoint.y - (this.bot.entity.position.y + this.bot.entity.height * 0.9)
    const dz = aimPoint.z - this.bot.entity.position.z

    const yaw = Math.atan2(-dx, -dz)
    const pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz))

    let targetYaw = yaw
    let targetPitch = pitch

    if (config.overshootEnabled) {
      const overshoot = overshootAngle(
        this.bot.entity.yaw,
        targetYaw,
        config.overshootAmplitude,
        config.overshootRecoveryFactor,
      )
      targetYaw = overshoot.value
      this.overshootRecovering = overshoot.recovering
    }

    if (config.microSaccadeAmplitude > 0 && shouldTrigger(config.microSaccadeFrequency)) {
      const saccade = microSaccade(config.microSaccadeAmplitude)
      targetYaw += saccade.yawDelta
      targetPitch += saccade.pitchDelta
    }

    targetPitch = Math.max(-PI_HALF, Math.min(PI_HALF, targetPitch))

    if (this.lookAwayTicksLeft > 0) {
      this.lookAwayTicksLeft--
      return
    }

    if (shouldTrigger(config.lookAwayProbability)) {
      this.lookAwayTicksLeft = Math.floor(
        config.lookAwayDurationTicks.min +
          Math.random() * (config.lookAwayDurationTicks.max - config.lookAwayDurationTicks.min),
      )
      return
    }

    const { lapseOccurs, durationTicks } = focusLapseCheck(
      this.config.humanization.focusLapseFrequency,
      this.config.humanization.focusLapseDurationTicks,
    )
    if (lapseOccurs) {
      this.lookAwayTicksLeft = durationTicks
      return
    }

    this.fittsTracker.update(targetYaw, targetPitch, this.currentTick)
    const { yaw: fittsYaw, pitch: fittsPitch } = this.fittsTracker.getSmoothedAngles()

    if (config.smooth) {
      const currentYaw = this.bot.entity.yaw
      const currentPitch = this.bot.entity.pitch

      const yawDiff = ((fittsYaw - currentYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI
      const pitchDiff = fittsPitch - currentPitch

      const smoothFactor = this.config.humanization.rotateSmoothFactor
      const newYaw = currentYaw + yawDiff * smoothFactor
      const newPitch = currentPitch + pitchDiff * smoothFactor

      void this.bot.look(newYaw, newPitch, config.mode === 'constant')
    } else {
      void this.bot.look(fittsYaw, fittsPitch, config.mode === 'constant')
    }
  }

  private shouldHitSelect(predFrame: PredictionFrame): boolean {
    if (!this.target) return false
    if (!this.wasInRange || !this.wasVisible) return false

    if (this.ticksSinceLastHurt < 4) {
      return true
    }

    const reach = this.botReach()
    return reach <= this.config.generic.attackRange
  }

  private async attemptAttack(): Promise<void> {
    if (!this.target) return

    const weapon = this.bot.heldItem
    if (weapon && !this.isWeapon(weapon)) {
      await this.equipBestWeapon()
    }

    this.ticksToNextAttack = Math.floor(20 / this.cps.getDebugState(this.currentTick).intendedCps)
    this.ticksSinceTargetAttack = 0

    await performAttack(this.bot, this.target, {
      swing: true,
      crit: this.config.critical.enabled,
    })

    this.strafe.recordHit()
    this.combo.recordHit()

    this.emit('attackedTarget', this.target)
  }

  private isWeapon(item: Item): boolean {
    const name = item.name
    return (
      name.includes('sword') ||
      name.includes('axe') ||
      name.includes('pickaxe') ||
      name.includes('shovel')
    )
  }

  private findWeapon(): Item | null {
    const items = this.bot.inventory.items()
    return items.find((item) => this.isWeapon(item)) || null
  }

  private async equipBestWeapon(): Promise<void> {
    const weapon = this.findWeapon()
    if (weapon) {
      await this.equip(weapon)
    }
  }

  private async equip(item: Item): Promise<void> {
    const slot = this.bot.inventory.findInventoryItem(item.type, null, false)
    if (slot) {
      await this.bot.equip(slot, 'hand')
      this.ticksSinceLastSwitch = 0
    }
  }

  private onTargetSwing = (entity: Entity) => {
    if (entity.id === this.target?.id) {
      this.ticksSinceTargetAttack = 0
    }
  }

  private onHealthChange = () => {
    const current = this.bot.health ?? 20
    if (current < this.lastHealth) {
      this.ticksSinceLastHurt = 0
      this.kbCounterTicksLeft = 3
    }
    this.lastHealth = current
  }

  private onTargetHurt = (entity: Entity) => {
    if (entity.id === this.target?.id) {
      this.ticksSinceLastTargetHurt = 0
      this.ticksSinceLastTargetHit = 0
    }
  }

  private onEntityGone = (entity: Entity) => {
    if (entity.id === this.target?.id) {
      this.stop()
    }
  }
}
