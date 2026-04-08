import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Vec3 } from 'vec3'
import { microSaccade, overshootAngle, focusLapseCheck } from '../util/humanizer.js'

const PI_HALF = Math.PI / 2

export class AimController {
  private lookAwayTicksLeft: number = 0
  private overshootRecovering: boolean = false
  private lastLookYaw: number = 0
  private lastLookPitch: number = 0

  constructor(
    private readonly bot: Bot,
    private readonly config: {
      smooth: boolean
      microSaccadeAmplitude: number
      microSaccadeFrequency: number
      lookAwayProbability: number
      lookAwayDurationTicks: { min: number; max: number }
      overshootEnabled: boolean
      overshootAmplitude: number
      overshootRecoveryFactor: number
      humanization: {
        focusLapseFrequency: number
        focusLapseDurationTicks: { min: number; max: number }
        rotateSmoothFactor: number
      }
    },
  ) {}

  aimAtPosition(targetPos: Vec3, targetHeight: number, currentTick: number): void {
    const aimPoint = targetPos.offset(0, targetHeight * 0.9, 0)

    const dx = aimPoint.x - this.bot.entity.position.x
    const dy = aimPoint.y - (this.bot.entity.position.y + this.bot.entity.height * 0.9)
    const dz = aimPoint.z - this.bot.entity.position.z

    let targetYaw = Math.atan2(-dx, -dz)
    let targetPitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz))

    if (this.config.overshootEnabled) {
      const overshoot = overshootAngle(
        this.bot.entity.yaw,
        targetYaw,
        this.config.overshootAmplitude,
        this.config.overshootRecoveryFactor,
      )
      targetYaw = overshoot.value
      this.overshootRecovering = overshoot.recovering
    }

    if (
      this.config.microSaccadeAmplitude > 0 &&
      Math.random() < this.config.microSaccadeFrequency
    ) {
      const saccade = microSaccade(this.config.microSaccadeAmplitude)
      targetYaw += saccade.yawDelta
      targetPitch += saccade.pitchDelta
    }

    targetPitch = Math.max(-PI_HALF, Math.min(PI_HALF, targetPitch))

    if (this.lookAwayTicksLeft > 0) {
      this.lookAwayTicksLeft--
      return
    }

    if (Math.random() < this.config.lookAwayProbability) {
      this.lookAwayTicksLeft = Math.floor(
        this.config.lookAwayDurationTicks.min +
          Math.random() *
            (this.config.lookAwayDurationTicks.max - this.config.lookAwayDurationTicks.min),
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

    if (this.config.smooth) {
      const currentYaw = this.bot.entity.yaw
      const currentPitch = this.bot.entity.pitch

      const yawDiff = ((targetYaw - currentYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI
      const pitchDiff = targetPitch - currentPitch

      const smoothFactor = this.config.humanization.rotateSmoothFactor
      const newYaw = currentYaw + yawDiff * smoothFactor
      const newPitch = currentPitch + pitchDiff * smoothFactor

      this.lastLookYaw = newYaw
      this.lastLookPitch = newPitch

      void this.bot.look(newYaw, newPitch, false)
    } else {
      this.lastLookYaw = targetYaw
      this.lastLookPitch = targetPitch
      void this.bot.look(targetYaw, targetPitch, false)
    }
  }

  reset(): void {
    this.lookAwayTicksLeft = 0
    this.overshootRecovering = false
  }

  getLastLookAngles(): { yaw: number; pitch: number } {
    return { yaw: this.lastLookYaw, pitch: this.lastLookPitch }
  }
}
