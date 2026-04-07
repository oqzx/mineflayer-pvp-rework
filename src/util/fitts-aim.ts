import { AABBUtils } from '@nxg-org/mineflayer-util-plugin'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'

function wrapAngle(a: number): number {
  const TWO_PI = Math.PI * 2
  while (a > Math.PI) a -= TWO_PI
  while (a < -Math.PI) a += TWO_PI
  return a
}

export class FittsAimTracker {
  private offsetFactor = 0
  private prevYawDiff: number | null = null

  computeAimPoint(botEyePos: Vec3, currentBotYaw: number, target: Entity, fittsBias: number): Vec3 {
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

    const aimY = aabb.minY + (aabb.maxY - aabb.minY) * 0.65

    const rightX = Math.cos(targetYaw)
    const rightZ = Math.sin(targetYaw)

    return new Vec3(
      target.position.x + rightX * lateralShift,
      aimY,
      target.position.z + rightZ * lateralShift,
    )
  }

  reset(): void {
    this.offsetFactor = 0
    this.prevYawDiff = null
  }
}
