import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import type { BowConfig } from '../../config/types.js'
import { trajectoryInfo } from '../../calc/constants.js'
import { AABBUtils } from '@nxg-org/mineflayer-util-plugin'
import {
  ShotFactory,
  InterceptFunctions,
  type BasicShotInfo,
} from '@nxg-org/mineflayer-trajectories'

export type SolvedAim = {
  yaw: number
  pitch: number
  flightTicks: number
  impactPosition: Vec3
}

export type AimResult = SolvedAim & {
  weaponName: string
  knockbackDir?: Vec3
}

export type ShotDebugInfo = {
  timestamp: number
  targetId: number
  predictedYaw: number
  predictedPitch: number
  predictedFlightTicks: number
  predictedImpactPos: Vec3
  expectedMissDist: number
  actualHit: boolean
  actualMissDist: number
  actualImpactTick: number
  actualTargetPosAtImpact: Vec3
  targetVelocity: Vec3
  regime: string
  scenariosUsed: number
  knockbackDir?: Vec3
}

const ARROW_GRAVITY = 0.05
const PLAYER_WIDTH = 0.6
const PITCH_MIN = -Math.PI * 0.44
const PITCH_MAX = Math.PI * 0.22
const VELOCITY_ALPHA = 0.55
const VELOCITY_HISTORY_TICKS = 10
const INTERCEPT_MAX_ITER = 20
const INTERCEPT_CONVERGENCE = 0.005
const PITCH_BISECT_ITER = 48
const LATENCY_TICKS = 2

let debugLog: (...args: unknown[]) => void = () => {}

export function enableDebugLogging(enabled: boolean): void {
  debugLog = enabled ? (...args) => console.log('[BowAiming]', ...args) : () => {}
}

const shotHistory: ShotDebugInfo[] = []
const MAX_HISTORY = 1000

export function getShotHistory(): ReadonlyArray<ShotDebugInfo> {
  return shotHistory
}

export function getAccuracyStats(): {
  shots: number
  hits: number
  avgExpectedMiss: number
  avgActualMiss: number
  hitRate: number
} {
  const shots = shotHistory.length
  const hits = shotHistory.filter((s) => s.actualHit).length
  const avgExpectedMiss =
    shots > 0 ? shotHistory.reduce((a, b) => a + b.expectedMissDist, 0) / shots : 0
  const avgActualMiss =
    shots > 0 ? shotHistory.reduce((a, b) => a + b.actualMissDist, 0) / shots : 0
  return { shots, hits, avgExpectedMiss, avgActualMiss, hitRate: shots > 0 ? hits / shots : 0 }
}

export function clearShotHistory(): void {
  shotHistory.length = 0
}

type TickSample = { pos: Vec3; tick: number }

class TickVelocityTracker {
  private readonly history: TickSample[] = []
  private emaVel: Vec3 = new Vec3(0, 0, 0)

  recordTick(pos: Vec3, tick: number): void {
    const prev = this.history[this.history.length - 1]
    if (prev !== undefined && tick > prev.tick) {
      const dtTicks = tick - prev.tick
      const rawVel = pos.minus(prev.pos).scaled(1 / dtTicks)
      this.emaVel = this.emaVel
        .scaled(1 - VELOCITY_ALPHA)
        .add(rawVel.scaled(VELOCITY_ALPHA))
    }
    this.history.push({ pos: pos.clone(), tick })
    if (this.history.length > VELOCITY_HISTORY_TICKS) this.history.shift()
  }

  getVelocityPerTick(): Vec3 {
    return this.emaVel.clone()
  }

  getLatestPosition(): Vec3 | null {
    return this.history.length > 0 ? this.history[this.history.length - 1]!.pos.clone() : null
  }

  reset(): void {
    this.history.length = 0
    this.emaVel = new Vec3(0, 0, 0)
  }
}

type ArrowPoint = { pos: Vec3; vel: Vec3; tick: number }

function simulateArrow(
  origin: Vec3,
  yaw: number,
  pitch: number,
  weaponName: string,
  maxTicks: number,
): ArrowPoint[] {
  const info = trajectoryInfo[weaponName] ?? trajectoryInfo['bow']!
  const cosPitch = Math.cos(pitch)
  const thetaY = Math.PI + yaw
  const vx = info.v0 * Math.sin(thetaY) * cosPitch
  const vy = info.v0 * Math.sin(pitch)
  const vz = info.v0 * Math.cos(thetaY) * cosPitch

  const vel = new Vec3(vx, vy, vz)
  const pos = origin.clone()
  const pts: ArrowPoint[] = []

  for (let t = 0; t < maxTicks; t++) {
    vel.x *= info.drag
    vel.y *= info.drag
    vel.z *= info.drag
    vel.y -= info.g
    pos.x += vel.x
    pos.y += vel.y
    pos.z += vel.z
    pts.push({ pos: pos.clone(), vel: vel.clone(), tick: t + 1 })
    if (pos.y < -64) break
  }

  return pts
}

function closestApproachTick(pts: ArrowPoint[], target: Vec3): { tick: number; dist: number } {
  let bestTick = 1
  let bestDist = Infinity
  for (const pt of pts) {
    const d = pt.pos.distanceTo(target)
    if (d < bestDist) {
      bestDist = d
      bestTick = pt.tick
    }
  }
  return { tick: bestTick, dist: bestDist }
}

function solvePitchBisect(
  origin: Vec3,
  targetCenter: Vec3,
  yaw: number,
  weaponName: string,
): number | null {
  const dx = targetCenter.x - origin.x
  const dy = targetCenter.y - origin.y
  const dz = targetCenter.z - origin.z
  const hDist = Math.sqrt(dx * dx + dz * dz)

  if (hDist < 0.001) {
    return dy > 0 ? PITCH_MAX : PITCH_MIN
  }

  const evalVerticalAtHDist = (pitch: number): number | null => {
    const pts = simulateArrow(origin, yaw, pitch, weaponName, 200)
    let prevH = 0
    let prevY = origin.y

    for (const pt of pts) {
      const ptdx = pt.pos.x - origin.x
      const ptdz = pt.pos.z - origin.z
      const h = Math.sqrt(ptdx * ptdx + ptdz * ptdz)
      if (h >= hDist) {
        const frac = prevH < hDist ? (hDist - prevH) / Math.max(h - prevH, 1e-9) : 0.5
        return prevY + (pt.pos.y - prevY) * frac
      }
      prevH = h
      prevY = pt.pos.y
    }
    return null
  }

  const hiVal = evalVerticalAtHDist(PITCH_MAX)
  if (hiVal !== null && hiVal < dy) return null

  const loVal = evalVerticalAtHDist(PITCH_MIN)
  if (loVal !== null && loVal > dy) return null

  let lo = PITCH_MIN
  let hi = PITCH_MAX

  for (let i = 0; i < PITCH_BISECT_ITER; i++) {
    const mid = (lo + hi) * 0.5
    const midVal = evalVerticalAtHDist(mid)
    if (midVal === null) {
      hi = mid
      continue
    }
    if (Math.abs(midVal - dy) < 0.005) return mid
    if (midVal < dy) lo = mid
    else hi = mid
  }

  return (lo + hi) * 0.5
}

function predictTargetPosition(
  currentPos: Vec3,
  velPerTick: Vec3,
  entityHeight: number,
  ticks: number,
  bot: Bot,
): Vec3 {
  const pos = currentPos.clone()
  const vel = velPerTick.clone()

  for (let i = 0; i < ticks; i++) {
    const blockBelow = bot.blockAt(pos.offset(0, -0.1, 0))
    const onGround = (blockBelow !== null && blockBelow.name !== 'air') && pos.y <= Math.floor(pos.y) + 0.3 && vel.y <= 0

    if (onGround) {
      vel.x *= 0.6
      vel.z *= 0.6
      vel.y = 0
      if (Math.abs(vel.x) < 0.005) vel.x = 0
      if (Math.abs(vel.z) < 0.005) vel.z = 0
    } else {
      vel.y -= 0.08
      vel.y *= 0.98
    }

    pos.x += vel.x
    pos.y += vel.y
    pos.z += vel.z
  }

  return pos.offset(0, entityHeight * 0.5, 0)
}

function solveIterativeIntercept(
  origin: Vec3,
  currentTargetPos: Vec3,
  targetVelPerTick: Vec3,
  entityHeight: number,
  weaponName: string,
  bot: Bot,
): { yaw: number; pitch: number; flightTicks: number; impactPos: Vec3 } | null {
  const roughDist = currentTargetPos.distanceTo(origin)
  let estimatedTicks = Math.max(4, Math.round(roughDist / 2.5) + LATENCY_TICKS)

  let finalYaw = 0
  let finalPitch = 0
  let finalTicks = estimatedTicks
  let finalImpact = currentTargetPos.clone()

  for (let iter = 0; iter < INTERCEPT_MAX_ITER; iter++) {
    const predictedCenter = predictTargetPosition(
      currentTargetPos,
      targetVelPerTick,
      entityHeight,
      estimatedTicks + LATENCY_TICKS,
      bot,
    )

    const dx = predictedCenter.x - origin.x
    const dz = predictedCenter.z - origin.z
    const yaw = Math.atan2(dx, dz) + Math.PI

    const pitch = solvePitchBisect(origin, predictedCenter, yaw, weaponName)
    if (pitch === null) return null

    const pts = simulateArrow(origin, yaw, pitch, weaponName, 200)
    const { tick: closestTick } = closestApproachTick(pts, predictedCenter)

    const prevTicks = estimatedTicks
    estimatedTicks = closestTick

    finalYaw = yaw
    finalPitch = pitch
    finalTicks = closestTick
    finalImpact = pts[closestTick - 1]?.pos ?? predictedCenter

    if (Math.abs(estimatedTicks - prevTicks) < 1) break
  }

  return {
    yaw: finalYaw,
    pitch: Math.max(PITCH_MIN, Math.min(PITCH_MAX, finalPitch)),
    flightTicks: finalTicks,
    impactPos: finalImpact,
  }
}

function validateShotWithFactory(
  bot: Bot,
  origin: Vec3,
  yaw: number,
  pitch: number,
  target: Entity,
  interceptFunctions: InterceptFunctions,
  weaponName: string,
): BasicShotInfo | null {
  const shot = ShotFactory.fromPlayer(
    {
      position: origin.offset(0, -1.62, 0),
      yaw,
      pitch,
      velocity: bot.entity.velocity,
      onGround: bot.entity.onGround,
    },
    interceptFunctions,
    weaponName,
  )
  const result = shot.hitsEntity(
    { position: target.position, height: target.height, width: target.width ?? PLAYER_WIDTH },
    { yawChecked: false, blockCheck: false },
  )
  return result?.shotInfo ?? null
}

function detectBridgeInfo(bot: Bot, target: Entity): { edgeDir: Vec3 } | null {
  const tp = target.position
  let bestDir: Vec3 | null = null
  let bestDrop = 0

  for (let angle = 0; angle < 2 * Math.PI; angle += Math.PI / 8) {
    const dir = new Vec3(Math.cos(angle), 0, Math.sin(angle))
    let drop = 0
    for (let dy = -1; dy >= -5; dy--) {
      const checkPos = tp.plus(dir.scaled(2.5)).offset(0, dy, 0)
      const block = bot.blockAt(checkPos)
      if (!block || block.name === 'air') drop++
      else break
    }
    if (drop > bestDrop) {
      bestDrop = drop
      bestDir = dir.clone()
    }
  }

  return bestDrop >= 3 && bestDir !== null ? { edgeDir: bestDir } : null
}

export class BowAiming {
  private readonly velTracker = new TickVelocityTracker()
  private intercept: InterceptFunctions | null = null
  private currentTick = 0
  private lastTargetId: number | null = null
  private pendingShot: {
    target: Entity
    predictedAim: SolvedAim
    expectedMiss: number
    weaponName: string
    knockbackDir?: Vec3
  } | null = null

  constructor(private readonly config: BowConfig) {}

  private getIntercept(bot: Bot): InterceptFunctions {
    if (this.intercept === null) {
      this.intercept = new InterceptFunctions(bot)
    }
    return this.intercept
  }

  compute(bot: Bot, target: Entity, weaponName: string): AimResult | null {
    this.currentTick++

    if (this.lastTargetId !== target.id) {
      this.velTracker.reset()
      this.lastTargetId = target.id
    }

    this.velTracker.recordTick(target.position.clone(), this.currentTick)

    const eyePos = bot.entity.position.offset(0, 1.62, 0)
    const velPerTick = this.velTracker.getVelocityPerTick()

    let aimTargetPos = target.position.clone()
    let knockbackDir: Vec3 | undefined = undefined

    if (this.config.bridgeKnockbackEnabled) {
      const bridgeInfo = detectBridgeInfo(bot, target)
      if (bridgeInfo !== null) {
        knockbackDir = bridgeInfo.edgeDir
        aimTargetPos = aimTargetPos.plus(bridgeInfo.edgeDir.scaled(0.7))
      }
    }

    debugLog('Computing aim', {
      tick: this.currentTick,
      targetId: target.id,
      targetPos: aimTargetPos.toString(),
      eyePos: eyePos.toString(),
      weapon: weaponName,
    })

    debugLog('Target velocity per tick', {
      velocity: velPerTick.toString(),
    })

    const intercept = solveIterativeIntercept(
      eyePos,
      aimTargetPos,
      velPerTick,
      target.height,
      weaponName,
      bot,
    )

    if (intercept === null) return null

    const expectedMiss = this.computeMissDistance(
      intercept,
      eyePos,
      aimTargetPos,
      velPerTick,
      target.height,
      weaponName,
      bot,
    )

    debugLog('Aim solution', {
      yaw: intercept.yaw,
      pitch: intercept.pitch,
      flightTicks: intercept.flightTicks,
      impactPos: intercept.impactPos.toString(),
      expectedMiss,
    })

    const solvedAim: SolvedAim = {
      yaw: intercept.yaw,
      pitch: intercept.pitch,
      flightTicks: intercept.flightTicks,
      impactPosition: intercept.impactPos,
    }

    this.pendingShot = {
      target,
      predictedAim: solvedAim,
      expectedMiss,
      weaponName,
      ...(knockbackDir !== undefined ? { knockbackDir } : {}),
    }

    return {
      ...solvedAim,
      weaponName,
      ...(knockbackDir !== undefined ? { knockbackDir } : {}),
    }
  }

  private computeMissDistance(
    intercept: { yaw: number; pitch: number; flightTicks: number; impactPos: Vec3 },
    origin: Vec3,
    targetCurrentPos: Vec3,
    velPerTick: Vec3,
    entityHeight: number,
    weaponName: string,
    bot: Bot,
  ): number {
    const predictedCenter = predictTargetPosition(
      targetCurrentPos,
      velPerTick,
      entityHeight,
      intercept.flightTicks + LATENCY_TICKS,
      bot,
    )

    const arrowPts = simulateArrow(origin, intercept.yaw, intercept.pitch, weaponName, intercept.flightTicks)
    const arrowPos = arrowPts[arrowPts.length - 1]?.pos ?? intercept.impactPos

    const hw = PLAYER_WIDTH / 2
    const dx = Math.max(0, Math.abs(arrowPos.x - predictedCenter.x) - hw)
    const dz = Math.max(0, Math.abs(arrowPos.z - predictedCenter.z) - hw)
    const dy = Math.max(0, Math.abs(arrowPos.y - predictedCenter.y) - entityHeight / 2)

    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  recordShotResult(hit: boolean, actualImpactTick?: number): void {
    if (this.pendingShot === null) return

    const { target, predictedAim, expectedMiss, knockbackDir } = this.pendingShot
    const actualPos = target.position.clone()
    const actualVel = this.velTracker.getVelocityPerTick()
    const actualMissDist = hit ? 0 : actualPos.distanceTo(predictedAim.impactPosition)

    const entry: ShotDebugInfo = {
      timestamp: Date.now(),
      targetId: target.id,
      predictedYaw: predictedAim.yaw,
      predictedPitch: predictedAim.pitch,
      predictedFlightTicks: predictedAim.flightTicks,
      predictedImpactPos: predictedAim.impactPosition.clone(),
      expectedMissDist: expectedMiss,
      actualHit: hit,
      actualMissDist,
      actualImpactTick: actualImpactTick ?? predictedAim.flightTicks,
      actualTargetPosAtImpact: actualPos,
      targetVelocity: actualVel,
      regime: 'iterative-intercept',
      scenariosUsed: 1,
      ...(knockbackDir !== undefined ? { knockbackDir: knockbackDir.clone() } : {}),
    }

    shotHistory.push(entry)
    if (shotHistory.length > MAX_HISTORY) shotHistory.shift()

    this.pendingShot = null
  }

  reset(): void {
    this.velTracker.reset()
    this.lastTargetId = null
    this.pendingShot = null
    this.intercept = null
  }
}
