import type { Bot, ControlState } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import type { StrafeConfig } from '../config/types.js'
import { getTargetYaw } from '../calc/math.js'
import { randomIntInRange, shouldTrigger, gaussianNoise } from '../util/humanizer.js'

type StrafeMode = 'circle' | 'random' | 'intelligent' | 'predictive'

export class StrafeController {
  private currentDir: ControlState | undefined = undefined
  private counter: number = 0
  private velocityHistory: Vec3[] = []
  private pauseTicksLeft: number = 0
  private circleHitsSinceSwitch: number = 0
  private circleNextSwitchAt: number
  private circleCurrentDir: 'left' | 'right' = 'left'

  constructor(private readonly config: StrafeConfig) {
    this.circleNextSwitchAt = randomIntInRange(config.circleSwitchIntervalHits)
  }

  update(
    bot: Bot,
    target: Entity,
    botReach: number,
    attackRange: number,
    forcedDir?: 'left' | 'right',
    fatigueMultiplier = 1,
    hitsLanded = 0,
  ): void {
    if (!this.config.enabled) return

    const diff = getTargetYaw(target.position, bot.entity.position) - target.yaw
    const inAngle = Math.abs(diff) < this.config.maxAngleOffset
    const inRange = botReach <= attackRange + 3

    if (!inAngle) {
      this.clearDir(bot)
      return
    }
    
    if (this.pauseTicksLeft > 0) {
      this.pauseTicksLeft--
      this.clearDir(bot)
      return
    }

    const pauseProb =
      this.config.pauseProbability *
      (1 / Math.max(0.1, fatigueMultiplier)) *
      (inRange ? 0.3 : 1.0)

    if (shouldTrigger(pauseProb)) {
      this.pauseTicksLeft = randomIntInRange(this.config.pauseDurationTicks)
      this.clearDir(bot)
      return
    }

    if (forcedDir) {
      this.applyDir(bot, forcedDir, inRange)
      return
    }

    switch (this.config.mode as StrafeMode) {
      case 'circle':
        this.updateCircle(bot, diff, inRange, hitsLanded, fatigueMultiplier)
        break
      case 'random':
        this.updateRandom(bot, inRange, fatigueMultiplier)
        break
      case 'intelligent':
        this.updateIntelligent(bot, inRange, fatigueMultiplier)
        break
      case 'predictive':
        this.updatePredictive(bot, target, inRange, fatigueMultiplier)
        break
    }
  }

  recordHit(): void {
    this.circleHitsSinceSwitch++
    if (this.config.circleSwitchEnabled && this.circleHitsSinceSwitch >= this.circleNextSwitchAt) {
      this.circleCurrentDir = this.circleCurrentDir === 'left' ? 'right' : 'left'
      this.circleHitsSinceSwitch = 0
      this.circleNextSwitchAt = randomIntInRange(this.config.circleSwitchIntervalHits)
    }
  }

  clearDir(bot: Bot): void {
    if (this.currentDir) {
      bot.setControlState(this.currentDir, false)
      this.currentDir = undefined
    }
  }

  private applyDir(bot: Bot, dir: ControlState, inRange: boolean): void {
    const opposite: ControlState = dir === 'left' ? 'right' : 'left'
    if (!inRange) {
      this.clearDir(bot)
      return
    }
    if (dir !== this.currentDir) {
      if (this.currentDir) bot.setControlState(this.currentDir, false)
      this.currentDir = dir
    }
    bot.setControlState(dir, true)
    bot.setControlState(opposite, false)
  }

  private updateCircle(
    bot: Bot,
    _diff: number,
    inRange: boolean,
    _hitsLanded: number,
    fatigueMultiplier: number,
  ): void {
    const dir = this.circleCurrentDir
    const jitterAmt = this.config.durationJitter
    if (this.counter <= 0) {
      const base = randomIntInRange(jitterAmt)
      this.counter = Math.max(1, Math.round(base * fatigueMultiplier))
      this.applyDir(bot, dir, inRange)
    } else {
      this.counter--
    }
  }

  private updateRandom(bot: Bot, inRange: boolean, fatigueMultiplier: number): void {
    const dirs: ControlState[] = ['left', 'right']
    const dir = dirs[Math.floor(Math.random() * dirs.length)]!
    const jitterAmt = this.config.durationJitter
    if (this.counter <= 0) {
      const base = randomIntInRange(jitterAmt)
      this.counter = Math.max(1, Math.round(base * fatigueMultiplier))
      this.applyDir(bot, dir, inRange)
    } else {
      this.counter--
    }
  }

  private updateIntelligent(bot: Bot, inRange: boolean, fatigueMultiplier: number): void {
    const dir = this.currentDir ?? (Math.random() > 0.5 ? 'left' : 'right')
    const jitterAmt = this.config.durationJitter
    if (this.counter <= 0) {
      const base = randomIntInRange(jitterAmt)
      this.counter = Math.max(1, Math.round(base * fatigueMultiplier))
      this.applyDir(bot, dir, inRange)
    } else {
      this.counter--
    }
  }

  private updatePredictive(
    bot: Bot,
    target: Entity,
    inRange: boolean,
    fatigueMultiplier: number,
  ): void {
    const vel = target.velocity
    const cross = vel.x * (bot.entity.position.z - target.position.z) -
                  vel.z * (bot.entity.position.x - target.position.x)
    const dir: ControlState = cross > 0 ? 'left' : 'right'
    const jitterAmt = this.config.durationJitter
    if (this.counter <= 0) {
      const base = randomIntInRange(jitterAmt)
      this.counter = Math.max(1, Math.round(base * fatigueMultiplier))
      this.applyDir(bot, dir, inRange)
    } else {
      this.counter--
    }
  }
}
