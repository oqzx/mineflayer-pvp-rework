import type { Bot, ControlState } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Vec3 } from 'vec3'
import type { StrafeConfig } from '../config/types.js'
import { getTargetYaw } from '../calc/math.js'
import { randomIntInRange, shouldTrigger, gaussianNoise } from '../util/humanizer.js'

type StrafeMode = 'circle' | 'random' | 'intelligent' | 'predictive'

type StrafePattern =
  | 'sustained'
  | 'burst'
  | 'oscillate'
  | 'feint'
  | 'freeze'

export class StrafeController {
  private currentDir: ControlState | undefined = undefined
  private counter: number = 0
  private velocityHistory: Vec3[] = []
  private pauseTicksLeft: number = 0
  private circleHitsSinceSwitch: number = 0
  private circleNextSwitchAt: number
  private circleCurrentDir: 'left' | 'right' = 'left'

  private pattern: StrafePattern = 'sustained'
  private patternTicksLeft: number = 0
  private oscillatePhaseTick: number = 0
  private feintPhase: 'fake' | 'real' = 'fake'
  private feintTicksLeft: number = 0
  private burstTicksLeft: number = 0
  private burstDir: ControlState = 'left'
  private lastHitCount: number = 0
  private consecutiveHits: number = 0
  private noiseAccum: number = 0
  private entropy: number = 0

  constructor(private readonly config: StrafeConfig) {
    this.circleNextSwitchAt = randomIntInRange(config.circleSwitchIntervalHits)
    this.pickNewPattern()
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
      (inRange ? 0.2 : 1.0)

    if (shouldTrigger(pauseProb)) {
      this.pauseTicksLeft = randomIntInRange(this.config.pauseDurationTicks)
      this.clearDir(bot)
      return
    }

    if (forcedDir) {
      this.applyDir(bot, forcedDir, inRange)
      return
    }

    this.entropy += gaussianNoise(0.08)
    this.entropy = Math.max(0, Math.min(1, this.entropy))

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
    this.consecutiveHits++
    this.circleHitsSinceSwitch++
    if (this.config.circleSwitchEnabled && this.circleHitsSinceSwitch >= this.circleNextSwitchAt) {
      this.circleCurrentDir = this.circleCurrentDir === 'left' ? 'right' : 'left'
      this.circleHitsSinceSwitch = 0
      this.circleNextSwitchAt = randomIntInRange(this.config.circleSwitchIntervalHits)
    }
    if (this.consecutiveHits % 3 === 0) {
      this.entropy += 0.25
      this.pickNewPattern()
    }
  }

  clearDir(bot: Bot): void {
    if (this.currentDir) {
      bot.setControlState(this.currentDir, false)
      this.currentDir = undefined
    }
  }

  private pickNewPattern(): void {
    const rand = Math.random()
    const highEntropy = this.entropy > 0.6

    if (rand < 0.28) {
      this.pattern = 'sustained'
      this.patternTicksLeft = randomIntInRange({ min: 8, max: 22 })
    } else if (rand < 0.50) {
      this.pattern = 'burst'
      this.patternTicksLeft = randomIntInRange({ min: 3, max: 7 })
      this.burstTicksLeft = this.patternTicksLeft
      this.burstDir = Math.random() > 0.5 ? 'left' : 'right'
    } else if (rand < 0.66) {
      this.pattern = 'oscillate'
      this.patternTicksLeft = randomIntInRange({ min: 10, max: 20 })
      this.oscillatePhaseTick = 0
    } else if (rand < (highEntropy ? 0.88 : 0.78)) {
      this.pattern = 'feint'
      this.feintPhase = 'fake'
      this.feintTicksLeft = randomIntInRange({ min: 2, max: 5 })
      this.patternTicksLeft = 12
    } else {
      this.pattern = 'freeze'
      this.patternTicksLeft = randomIntInRange({ min: 1, max: 4 })
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
    this.runPattern(bot, this.circleCurrentDir, inRange, fatigueMultiplier)
  }

  private updateRandom(bot: Bot, inRange: boolean, fatigueMultiplier: number): void {
    this.runPattern(bot, this.circleCurrentDir, inRange, fatigueMultiplier)
  }

  private updateIntelligent(bot: Bot, inRange: boolean, fatigueMultiplier: number): void {
    const dir = this.currentDir ?? (Math.random() > 0.5 ? 'left' : 'right')
    this.runPattern(bot, dir as 'left' | 'right', inRange, fatigueMultiplier)
  }

  private updatePredictive(
    bot: Bot,
    target: Entity,
    inRange: boolean,
    fatigueMultiplier: number,
  ): void {
    const vel = target.velocity
    const cross =
      vel.x * (bot.entity.position.z - target.position.z) -
      vel.z * (bot.entity.position.x - target.position.x)
    const baseDir: 'left' | 'right' = cross > 0 ? 'left' : 'right'
    this.runPattern(bot, baseDir, inRange, fatigueMultiplier)
  }

  private runPattern(
    bot: Bot,
    baseDir: 'left' | 'right',
    inRange: boolean,
    fatigueMultiplier: number,
  ): void {
    if (this.patternTicksLeft <= 0) {
      this.pickNewPattern()
      if (Math.random() < 0.3) {
        this.circleCurrentDir = Math.random() > 0.5 ? 'left' : 'right'
      }
    }
    this.patternTicksLeft--

    switch (this.pattern) {
      case 'sustained': {
        const jitterAmt = this.config.durationJitter
        if (this.counter <= 0) {
          const base = randomIntInRange(jitterAmt)
          this.counter = Math.max(1, Math.round(base * fatigueMultiplier))
          this.applyDir(bot, baseDir, inRange)
        } else {
          this.counter--
        }
        break
      }

      case 'burst': {
        if (this.burstTicksLeft > 0) {
          this.burstTicksLeft--
          this.applyDir(bot, this.burstDir, inRange)
        } else {
          this.clearDir(bot)
        }
        break
      }

      case 'oscillate': {
        this.oscillatePhaseTick++
        const period = Math.floor(3 + this.entropy * 4)
        const dir: ControlState =
          Math.floor(this.oscillatePhaseTick / period) % 2 === 0 ? 'left' : 'right'
        this.applyDir(bot, dir, inRange)
        break
      }

      case 'feint': {
        if (this.feintPhase === 'fake') {
          if (this.feintTicksLeft > 0) {
            this.feintTicksLeft--
            const fakeDir: ControlState = baseDir === 'left' ? 'right' : 'left'
            this.applyDir(bot, fakeDir, inRange)
          } else {
            this.feintPhase = 'real'
            this.feintTicksLeft = randomIntInRange({ min: 4, max: 9 })
          }
        } else {
          if (this.feintTicksLeft > 0) {
            this.feintTicksLeft--
            this.applyDir(bot, baseDir, inRange)
          } else {
            this.pattern = 'sustained'
            this.patternTicksLeft = randomIntInRange({ min: 5, max: 12 })
          }
        }
        break
      }

      case 'freeze': {
        this.clearDir(bot)
        break
      }
    }
  }
}
