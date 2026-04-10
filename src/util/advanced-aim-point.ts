import { AABBUtils } from '@nxg-org/mineflayer-util-plugin'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'

const MEAN_X = 0.00942273861037109
const STDDEV_X = 0.23319837528201348
const MEAN_Y = -0.30075078007595923
const STDDEV_Y = 0.3492437109081718
const MEAN_Z = 0.013282929419023442
const STDDEV_Z = 0.24453708645460387

function gaussian(mean: number, stddev: number): number {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
  return z * stddev + mean
}

function wrapAngle(a: number): number {
  const TWO_PI = Math.PI * 2
  while (a > Math.PI) a -= TWO_PI
  while (a < -Math.PI) a += TWO_PI
  return a
}

export class AdvancedAimPoint {
  private currentOffset: Vec3 = new Vec3(0, 0, 0)
  private targetOffset: Vec3 = new Vec3(0, 0, 0)
  private prevYawDiff: number | null = null
  private offsetFactor = 0

  compute(
    botEyePos: Vec3,
    target: Entity,
    currentBotYaw: number,
    fittsBias: number,
    eyeHeightVariance: number,
  ): Vec3 {
    const dx = target.position.x - botEyePos.x
    const dz = target.position.z - botEyePos.z
    const targetYaw = Math.atan2(-dx, -dz)
    const yawDiff = wrapAngle(targetYaw - currentBotYaw)

    let angularBias = 0
    if (this.prevYawDiff !== null) {
      const deltaYaw = wrapAngle(yawDiff - this.prevYawDiff)
      const movingAway = deltaYaw * yawDiff > 0
      angularBias = movingAway ? 0.4 : -0.3
    }
    this.prevYawDiff = yawDiff

    const absYaw = Math.abs(yawDiff)
    let baseFactor: number
    if (absYaw > 0.349) {
      baseFactor = 0.8
    } else if (absYaw < 0.0873) {
      baseFactor = -0.6
    } else {
      baseFactor = 0
    }

    const targetFactor = (baseFactor + angularBias) * fittsBias
    this.offsetFactor += (targetFactor - this.offsetFactor) * 0.25

    const aabb = AABBUtils.getEntityAABBRaw({
      position: target.position,
      height: target.height,
      width: target.width ?? 0.6,
    })

    const bbWidth = target.width ?? 0.6
    const maxLateral = bbWidth * 0.5 * 0.85
    const sign = yawDiff > 0 ? -1 : 1
    const lateralShift = this.offsetFactor * maxLateral * sign

    const baseY = aabb.minY + (aabb.maxY - aabb.minY) * 0.65

    this.updateGaussianOffset(target)

    const rightX = Math.cos(targetYaw)
    const rightZ = Math.sin(targetYaw)

    const aimX = target.position.x + rightX * lateralShift + this.currentOffset.x
    const aimY = baseY + this.currentOffset.y + gaussian(0, eyeHeightVariance)
    const aimZ = target.position.z + rightZ * lateralShift + this.currentOffset.z

    return new Vec3(aimX, aimY, aimZ)
  }

  private updateGaussianOffset(target: Entity): void {
    const distance = target.position.distanceTo(target.position)
    const dynamicFactor = Math.min(1.0, distance / 8.0)

    const tol = 0.05
    if (
      Math.abs(this.currentOffset.x - this.targetOffset.x) < tol &&
      Math.abs(this.currentOffset.y - this.targetOffset.y) < tol &&
      Math.abs(this.currentOffset.z - this.targetOffset.z) < tol
    ) {
      if (Math.random() < 0.85) {
        this.targetOffset = new Vec3(
          gaussian(MEAN_X, STDDEV_X) * dynamicFactor,
          gaussian(MEAN_Y, STDDEV_Y) * dynamicFactor,
          gaussian(MEAN_Z, STDDEV_Z) * dynamicFactor,
        )
      }
    }

    const speed = 0.15
    this.currentOffset = new Vec3(
      this.currentOffset.x + (this.targetOffset.x - this.currentOffset.x) * speed,
      this.currentOffset.y + (this.targetOffset.y - this.currentOffset.y) * speed,
      this.currentOffset.z + (this.targetOffset.z - this.currentOffset.z) * speed,
    )
  }

  reset(): void {
    this.currentOffset = new Vec3(0, 0, 0)
    this.targetOffset = new Vec3(0, 0, 0)
    this.prevYawDiff = null
    this.offsetFactor = 0
  }
}
