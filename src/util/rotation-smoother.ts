export interface Rotation {
  yaw: number
  pitch: number
}

function angleDifference(a: number, b: number): number {
  const diff = ((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI
  return diff < -Math.PI ? diff + Math.PI * 2 : diff
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function sigmoid(t: number, steepness: number = 8.0, midpoint: number = 0.3): number {
  return 1.0 / (1.0 + Math.exp(-steepness * (t - midpoint)))
}

export class RotationSmoother {
  private velocityYaw = 0
  private velocityPitch = 0
  private lastUpdateTick = 0

  smooth(current: Rotation, target: Rotation, tick: number): Rotation {
    this.lastUpdateTick = tick

    const yawDiff = angleDifference(target.yaw, current.yaw)
    const pitchDiff = target.pitch - current.pitch

    const yawMagnitude = Math.abs(yawDiff) / 180.0
    const pitchMagnitude = Math.abs(pitchDiff) / 90.0

    const yawSpeedBase = 0.22 + 0.18 * sigmoid(yawMagnitude, 10.0, 0.25)
    const pitchSpeedBase = 0.18 + 0.12 * sigmoid(pitchMagnitude, 10.0, 0.25)

    const yawAccel = 0.08
    const pitchAccel = 0.06

    const yawTargetVel = yawDiff * yawSpeedBase
    const pitchTargetVel = pitchDiff * pitchSpeedBase

    this.velocityYaw += (yawTargetVel - this.velocityYaw) * yawAccel
    this.velocityPitch += (pitchTargetVel - this.velocityPitch) * pitchAccel

    const maxYawStep = Math.abs(yawDiff) * 0.45 + 1.2
    const maxPitchStep = Math.abs(pitchDiff) * 0.35 + 0.9

    const stepYaw = clamp(this.velocityYaw, -maxYawStep, maxYawStep)
    const stepPitch = clamp(this.velocityPitch, -maxPitchStep, maxPitchStep)

    let newYaw = current.yaw + stepYaw
    let newPitch = current.pitch + stepPitch

    newPitch = clamp(newPitch, -90, 90)

    if (Math.abs(angleDifference(newYaw, target.yaw)) < 0.15) {
      newYaw = target.yaw
      this.velocityYaw = 0
    }
    if (Math.abs(newPitch - target.pitch) < 0.08) {
      newPitch = target.pitch
      this.velocityPitch = 0
    }

    return { yaw: newYaw, pitch: newPitch }
  }

  reset(): void {
    this.velocityYaw = 0
    this.velocityPitch = 0
    this.lastUpdateTick = 0
  }
}
