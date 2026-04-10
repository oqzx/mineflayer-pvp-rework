import type { Bot, ControlState } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { StrafeConfig } from '../config/types.js'
import { getTargetYaw } from '../calc/math.js'
import { randomIntInRange, shouldTrigger, gaussianNoise } from '../util/humanizer.js'

const PI = Math.PI
const TWO_PI = PI * 2

type StrafeMode = 'circle' | 'random' | 'intelligent' | 'predictive'
type StrafePattern = 'sustained' | 'burst' | 'oscillate' | 'feint' | 'freeze'

export class StrafeController {
  private orbitDir: 1 | -1 = 1
  private switchHitsLeft: number
  private activeDir: ControlState | undefined = undefined

  private pauseTicksLeft: number = 0
  private entropy: number = 0

  private pattern: StrafePattern = 'sustained'
  private patternTicksLeft: number = 0
  private sustainedCountdown: number = 0
  private oscillateTick: number = 0
  private burstDir: 'left' | 'right' = 'left'
  private burstTicksLeft: number = 0
  private feintPhase: 'fake' | 'real' = 'fake'
  private feintTicksLeft: number = 0

  private readonly velHistory: Array<{ x: number; z: number }> = []

  constructor(private readonly config: StrafeConfig) {
    this.switchHitsLeft = randomIntInRange(config.circleSwitchIntervalHits)
    this.pickPattern()
  }

  update(
    bot: Bot,
    target: Entity,
    botReach: number,
    attackRange: number,
    forcedDir?: 'left' | 'right',
    fatigueMultiplier = 1,
    _hitsLanded = 0,
  ): void {
    if (!this.config.enabled) return

    const inRange = botReach <= attackRange + 3

    if (!inRange) {
      this.releaseKeys(bot)
      return
    }

    if (this.pauseTicksLeft > 0) {
      this.pauseTicksLeft--
      this.releaseKeys(bot)
      return
    }

    const pauseProb = this.config.pauseProbability / Math.max(0.1, fatigueMultiplier)
    if (shouldTrigger(pauseProb)) {
      this.pauseTicksLeft = randomIntInRange(this.config.pauseDurationTicks)
      this.releaseKeys(bot)
      return
    }

    if ((bot.entity as { isCollidedHorizontally?: boolean }).isCollidedHorizontally) {
      this.orbitDir = (this.orbitDir * -1) as 1 | -1
    }

    this.entropy = Math.max(0, Math.min(1, this.entropy + gaussianNoise(0.06)))

    if (forcedDir) {
      this.applyLateral(bot, forcedDir)
      return
    }

    const baseDir = this.resolveBaseDir(bot, target, fatigueMultiplier)
    if (baseDir === null) {
      this.releaseKeys(bot)
      return
    }

    this.runPattern(bot, baseDir, fatigueMultiplier)
  }

  recordHit(): void {
    this.entropy = Math.min(1, this.entropy + 0.15)
    if (!this.config.circleSwitchEnabled) return
    this.switchHitsLeft--
    if (this.switchHitsLeft <= 0) {
      this.orbitDir = (this.orbitDir * -1) as 1 | -1
      this.switchHitsLeft = randomIntInRange(this.config.circleSwitchIntervalHits)
      this.pickPattern()
    }
  }

  clearDir(bot: Bot): void {
    this.releaseKeys(bot)
  }

  private resolveBaseDir(
    bot: Bot,
    target: Entity,
    fatigueMultiplier: number,
  ): 'left' | 'right' | null {
    switch (this.config.mode as StrafeMode) {
      case 'circle':
        return this.orbitDir === 1 ? 'left' : 'right'

      case 'random': {
        this.sustainedCountdown--
        if (this.sustainedCountdown <= 0) {
          const base = randomIntInRange(this.config.durationJitter)
          this.sustainedCountdown = Math.max(1, Math.round(base / Math.max(0.1, fatigueMultiplier)))
          if (shouldTrigger(0.45 + this.entropy * 0.25)) {
            this.orbitDir = (this.orbitDir * -1) as 1 | -1
          }
        }
        return this.orbitDir === 1 ? 'left' : 'right'
      }

      case 'intelligent': {
        const toTarget = getTargetYaw(target.position, bot.entity.position)
        const diff = ((toTarget - target.yaw + PI * 3) % TWO_PI) - PI
        const geometricDir: 1 | -1 = diff > 0 ? 1 : -1
        if (geometricDir !== this.orbitDir && shouldTrigger(0.12 + this.entropy * 0.08)) {
          this.orbitDir = geometricDir
        }
        return this.orbitDir === 1 ? 'left' : 'right'
      }

      case 'predictive': {
        const vel = target.velocity
        this.velHistory.push({ x: vel.x, z: vel.z })
        if (this.velHistory.length > 8) this.velHistory.shift()

        const avg = this.velHistory.reduce((acc, v) => ({ x: acc.x + v.x, z: acc.z + v.z }), {
          x: 0,
          z: 0,
        })
        const len = this.velHistory.length
        avg.x /= len
        avg.z /= len

        const dx = bot.entity.position.x - target.position.x
        const dz = bot.entity.position.z - target.position.z
        const cross = avg.x * dz - avg.z * dx
        const noise = gaussianNoise(this.config.predictiveNoiseFactor)
        const preferred: 1 | -1 = cross + noise > 0 ? -1 : 1
        if (preferred !== this.orbitDir && shouldTrigger(0.25)) {
          this.orbitDir = preferred
        }
        return this.orbitDir === 1 ? 'left' : 'right'
      }
    }
  }

  private runPattern(bot: Bot, baseDir: 'left' | 'right', fatigueMultiplier: number): void {
    if (this.patternTicksLeft <= 0) {
      this.pickPattern()
    }
    this.patternTicksLeft--

    switch (this.pattern) {
      case 'sustained': {
        this.sustainedCountdown--
        if (this.sustainedCountdown <= 0) {
          const base = randomIntInRange(this.config.durationJitter)
          this.sustainedCountdown = Math.max(1, Math.round(base * fatigueMultiplier))
          this.applyLateral(bot, baseDir)
        }
        break
      }

      case 'burst': {
        if (this.burstTicksLeft > 0) {
          this.burstTicksLeft--
          this.applyLateral(bot, this.burstDir)
        } else {
          this.releaseKeys(bot)
        }
        break
      }

      case 'oscillate': {
        this.oscillateTick++
        const period = Math.max(2, Math.floor(3 + this.entropy * 4))
        const dir: 'left' | 'right' =
          Math.floor(this.oscillateTick / period) % 2 === 0 ? 'left' : 'right'
        this.applyLateral(bot, dir)
        break
      }

      case 'feint': {
        if (this.feintPhase === 'fake') {
          if (this.feintTicksLeft > 0) {
            this.feintTicksLeft--
            this.applyLateral(bot, baseDir === 'left' ? 'right' : 'left')
          } else {
            this.feintPhase = 'real'
            this.feintTicksLeft = randomIntInRange({ min: 4, max: 9 })
          }
        } else {
          if (this.feintTicksLeft > 0) {
            this.feintTicksLeft--
            this.applyLateral(bot, baseDir)
          } else {
            this.pattern = 'sustained'
            this.patternTicksLeft = randomIntInRange({ min: 5, max: 14 })
            this.sustainedCountdown = 0
          }
        }
        break
      }

      case 'freeze': {
        this.releaseKeys(bot)
        break
      }
    }
  }

  private pickPattern(): void {
    const r = Math.random()
    const highEntropy = this.entropy > 0.6

    if (r < 0.3) {
      this.pattern = 'sustained'
      this.patternTicksLeft = randomIntInRange({ min: 8, max: 22 })
      this.sustainedCountdown = 0
    } else if (r < 0.5) {
      this.pattern = 'burst'
      this.burstTicksLeft = randomIntInRange({ min: 3, max: 7 })
      this.patternTicksLeft = this.burstTicksLeft + 2
      this.burstDir = Math.random() > 0.5 ? 'left' : 'right'
    } else if (r < 0.65) {
      this.pattern = 'oscillate'
      this.patternTicksLeft = randomIntInRange({ min: 10, max: 20 })
      this.oscillateTick = 0
    } else if (r < (highEntropy ? 0.88 : 0.8)) {
      this.pattern = 'feint'
      this.feintPhase = 'fake'
      this.feintTicksLeft = randomIntInRange({ min: 2, max: 5 })
      this.patternTicksLeft = 14
    } else {
      this.pattern = 'freeze'
      this.patternTicksLeft = randomIntInRange({ min: 1, max: 4 })
    }
  }

  private applyLateral(bot: Bot, dir: 'left' | 'right'): void {
    const opposite: ControlState = dir === 'left' ? 'right' : 'left'
    if (this.activeDir !== dir) {
      if (this.activeDir) bot.setControlState(this.activeDir, false)
      this.activeDir = dir
    }
    bot.setControlState(dir, true)
    bot.setControlState(opposite, false)
  }

  private releaseKeys(bot: Bot): void {
    if (this.activeDir) {
      bot.setControlState(this.activeDir, false)
      this.activeDir = undefined
    }
  }
}
