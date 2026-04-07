import type { AABB } from '@nxg-org/mineflayer-util-plugin'
import { AABBUtils } from '@nxg-org/mineflayer-util-plugin'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'

const PI = Math.PI
const PI_2 = PI * 2
const TO_RAD = PI / 180
const TO_DEG = 1 / TO_RAD
const FROM_NOTCH_BYTE = 360 / 256
const FROM_NOTCH_VEL = 1 / 8000

export const toNotchianYaw = (yaw: number): number => toDegrees(PI - yaw)
export const toNotchianPitch = (pitch: number): number => toDegrees(-pitch)
export const fromNotchianYawByte = (yaw: number): number => fromNotchianYaw(yaw * FROM_NOTCH_BYTE)
export const fromNotchianPitchByte = (pitch: number): number =>
  fromNotchianPitch(pitch * FROM_NOTCH_BYTE)

export function euclideanMod(numerator: number, denominator: number): number {
  const result = numerator % denominator
  return result < 0 ? result + denominator : result
}

export function toRadians(degrees: number): number {
  return TO_RAD * degrees
}

export function toDegrees(radians: number): number {
  return TO_DEG * radians
}

export function fromNotchianYaw(yaw: number): number {
  return euclideanMod(PI - toRadians(yaw), PI_2)
}

export function fromNotchianPitch(pitch: number): number {
  return euclideanMod(toRadians(-pitch) + PI, PI_2) - PI
}

export function fromNotchVelocity(vel: Vec3): Vec3 {
  return new Vec3(vel.x * FROM_NOTCH_VEL, vel.y * FROM_NOTCH_VEL, vel.z * FROM_NOTCH_VEL)
}

export function pointToYawAndPitch(origin: Vec3, point: Vec3): { yaw: number; pitch: number } {
  return dirToYawAndPitch(point.minus(origin))
}

export function dirToYawAndPitch(dir: Vec3): { yaw: number; pitch: number } {
  const yaw = Math.atan2(dir.x, dir.z) + PI
  const groundDistance = Math.sqrt(dir.x * dir.x + dir.z * dir.z)
  const pitch = Math.atan2(dir.y, groundDistance)
  return { yaw, pitch }
}

export function getTargetDistance(
  origin: Vec3,
  destination: Vec3,
): { distance: number; hDistance: number; yDistance: number } {
  const dx = origin.x - destination.x
  const dz = origin.z - destination.z
  const hDistance = Math.sqrt(dx * dx + dz * dz)
  const yDistance = destination.y - origin.y
  const distance = Math.sqrt(yDistance * yDistance + dx * dx + dz * dz)
  return { distance, hDistance, yDistance }
}

export function getTargetYaw(origin: Vec3, destination: Vec3): number {
  return Math.atan2(destination.x - origin.x, destination.z - origin.z) + PI
}

export function vectorMagnitude(vec: Vec3): number {
  return Math.sqrt(vec.x * vec.x + vec.y * vec.y + vec.z * vec.z)
}

export function voxFromVector(vec: Vec3, magnitude?: number): number {
  const mag = magnitude ?? vectorMagnitude(vec)
  return Math.sqrt(Math.max(0, mag * mag - vec.y * vec.y))
}

export function yawPitchToDir(yaw: number, pitch: number, speed: number): Vec3 {
  const thetaY = PI + yaw
  const x = speed * Math.sin(thetaY)
  const y = speed * Math.sin(pitch)
  const z = speed * Math.cos(thetaY)
  const vxMag = Math.sqrt(x * x + z * z)
  if (vxMag === 0) return new Vec3(0, y, 0)
  const ratio = Math.sqrt(Math.max(0, vxMag * vxMag - y * y)) / vxMag
  return new Vec3(x * ratio, y, z * ratio)
}

export function movingTowards(origin: Vec3, destination: Vec3, velocity: Vec3): boolean {
  return origin.distanceTo(destination) >= origin.plus(velocity).distanceTo(destination)
}

export function movingAt(
  origin: Vec3,
  destination: Vec3,
  velocity: Vec3,
  maxOffset: number,
): boolean {
  const mag = vectorMagnitude(velocity)
  if (mag === 0) return false
  return (
    Math.abs(dirToYawAndPitch(velocity.normalize()).yaw - getTargetYaw(origin, destination)) <
    maxOffset
  )
}

export function lookingAt(origin: Entity, target: Entity, maxDistance?: number): boolean {
  const dir = yawPitchToDir(origin.yaw, origin.pitch, 1)
  const eyePos = origin.position.offset(0, origin.height, 0)
  const targetAabb = AABBUtils.getEntityAABBRaw({
    position: target.position,
    height: target.height,
    width: target.width ?? 0.6,
  })
  return lookingAtFromRay(eyePos, targetAabb, dir, maxDistance)
}

export function lookingAtFromRay(
  origin: Vec3,
  target: AABB,
  dir: Vec3,
  maxDistance?: number,
): boolean {
  if (maxDistance === undefined) return !!target.intersectsRay(origin, dir)
  const res = target.intersectsRay(origin, dir)
  return res ? origin.distanceTo(res) < maxDistance : false
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a
  while (diff > PI) diff -= PI_2
  while (diff < -PI) diff += PI_2
  return a + diff * t
}
