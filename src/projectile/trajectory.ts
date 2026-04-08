import { Vec3 } from 'vec3'
import { trajectoryInfo } from '../calc/constants.js'
import { yawPitchToDir } from '../calc/math.js'

export type TrajectoryPoint = {
  position: Vec3
  velocity: Vec3
  tick: number
}

export type TrajectoryResult = {
  points: TrajectoryPoint[]
  totalTicks: number
  finalPosition: Vec3
}

export type SolvedAim = {
  yaw: number
  pitch: number
  flightTicks: number
  impactPosition: Vec3
}

export function simulateProjectile(
  origin: Vec3,
  yaw: number,
  pitch: number,
  weaponName: string,
  maxTicks = 120,
): TrajectoryResult {
  const info = trajectoryInfo[weaponName] ?? trajectoryInfo['bow'] ?? { v0: 3.0, g: 0.05, drag: 0.99 }
  const vel = yawPitchToDir(yaw, pitch, info.v0)
  const pos = origin.clone()
  const points: TrajectoryPoint[] = []

  for (let t = 0; t < maxTicks; t++) {
    pos.x += vel.x
    pos.y += vel.y
    pos.z += vel.z

    vel.x *= info.drag
    vel.y *= info.drag
    vel.z *= info.drag
    vel.y -= info.g

    points.push({
      position: pos.clone(),
      velocity: vel.clone(),
      tick: t + 1,
    })

    if (pos.y < -64) break
  }

  return {
    points,
    totalTicks: points.length,
    finalPosition: pos.clone(),
  }
}

export function closestApproachTick(points: TrajectoryPoint[], target: Vec3): number {
  let bestTick = 0
  let bestDist = Infinity
  for (const pt of points) {
    const d = pt.position.distanceTo(target)
    if (d < bestDist) {
      bestDist = d
      bestTick = pt.tick
    }
  }
  return bestTick
}

function verticalAtHDist(
  pitch: number,
  hDist: number,
  weaponName: string,
): { v: number; tick: number } | null {
  const sim = simulateProjectile(new Vec3(0, 0, 0), 0, pitch, weaponName, 200)
  let prevH = 0
  let prevV = 0

  for (const pt of sim.points) {
    const h = Math.sqrt(pt.position.x * pt.position.x + pt.position.z * pt.position.z)
    if (h >= hDist) {
      const dH = h - prevH
      const frac = dH > 0 ? (hDist - prevH) / dH : 0.5
      const v = prevV + (pt.position.y - prevV) * frac
      return { v, tick: pt.tick }
    }
    prevH = h
    prevV = pt.position.y
  }
  return null
}

export function solvePitch(
  hDist: number,
  vDist: number,
  weaponName: string,
): number | null {
  if (hDist < 0.001) return -Math.PI / 2

  let lo = -Math.PI * 0.44
  let hi = Math.PI * 0.44

  const hiCheck = verticalAtHDist(hi, hDist, weaponName)
  if (hiCheck && hiCheck.v < vDist) return null

  const loCheck = verticalAtHDist(lo, hDist, weaponName)
  if (loCheck && loCheck.v > vDist) return null

  for (let iter = 0; iter < 32; iter++) {
    const mid = (lo + hi) * 0.5
    const midCheck = verticalAtHDist(mid, hDist, weaponName)

    if (!midCheck) {
      hi = mid
      continue
    }

    if (Math.abs(midCheck.v - vDist) < 0.02) {
      return mid
    }

    if (midCheck.v < vDist) {
      lo = mid
    } else {
      hi = mid
    }
  }

  const finalPitch = (lo + hi) * 0.5
  const finalCheck = verticalAtHDist(finalPitch, hDist, weaponName)
  if (!finalCheck || Math.abs(finalCheck.v - vDist) > 2.0) return null
  return finalPitch
}

export function solveAimIterative(
  origin: Vec3,
  targetEntity: { position: Vec3; velocity: Vec3; height: number; acceleration?: Vec3 },
  weaponName: string,
  iterations = 12,
): SolvedAim | null {
  const targetVel = targetEntity.velocity
  const targetAcc = targetEntity.acceleration ?? new Vec3(0, 0, 0)

  let predictedPos = targetEntity.position.offset(0, targetEntity.height * 0.5, 0)

  for (let iter = 0; iter < iterations; iter++) {
    const dx = predictedPos.x - origin.x
    const dy = predictedPos.y - origin.y
    const dz = predictedPos.z - origin.z
    const hDist = Math.sqrt(dx * dx + dz * dz)
    const yaw = Math.atan2(dx, dz) + Math.PI

    const pitch = solvePitch(hDist, dy, weaponName)
    if (pitch === null) return null

    const result = simulateProjectile(origin, yaw, pitch, weaponName, 200)
    const closestTick = closestApproachTick(result.points, predictedPos)

    const t = closestTick
    predictedPos = targetEntity.position
      .offset(0, targetEntity.height * 0.5, 0)
      .offset(
        targetVel.x * t + 0.5 * targetAcc.x * t * t,
        targetVel.y * t + 0.5 * targetAcc.y * t * t,
        targetVel.z * t + 0.5 * targetAcc.z * t * t,
      )

    const pt = result.points[closestTick - 1]
    if (pt && pt.position.distanceTo(predictedPos) < 0.15) {
      return {
        yaw,
        pitch,
        flightTicks: closestTick,
        impactPosition: pt.position.clone(),
      }
    }
  }

  const dx = predictedPos.x - origin.x
  const dy = predictedPos.y - origin.y
  const dz = predictedPos.z - origin.z
  const hDist = Math.sqrt(dx * dx + dz * dz)
  const yaw = Math.atan2(dx, dz) + Math.PI
  const pitch = solvePitch(hDist, dy, weaponName)
  if (pitch === null) return null

  const result = simulateProjectile(origin, yaw, pitch, weaponName, 200)
  const closestTick = closestApproachTick(result.points, predictedPos)
  const pt = result.points[closestTick - 1]

  return {
    yaw,
    pitch,
    flightTicks: closestTick,
    impactPosition: pt?.position.clone() ?? predictedPos,
  }
}

export function estimatePearlLandingPosition(origin: Vec3, yaw: number, pitch: number): Vec3 {
  const result = simulateProjectile(origin, yaw, pitch, 'ender_pearl', 80)
  return result.finalPosition
}
