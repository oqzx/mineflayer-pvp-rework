import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import type { BowConfig } from '../../config/types.js'
import { trajectoryInfo } from '../../calc/constants.js'

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

const ARROW_DRAG = 0.99
const ARROW_GRAVITY = 0.05
const PLAYER_WIDTH = 0.6
const ARROW_SIZE = 0.5
const MAX_FLIGHT_TICKS = 200
const PITCH_LOWER = -Math.PI * 0.44
const PITCH_UPPER = Math.PI * 0.22
const VELOCITY_SMOOTH_FACTOR = 0.85
const POSITION_HISTORY_SIZE = 20
const OPT_GRID_STEPS = 100
const OPT_NM_ITER = 200
const OPT_NM_TOL = 1e-8
const OPT_LOCAL_STEPS = 12
const LATENCY_TICKS = 2
const REACT_TICKS = 5

type PositionSample = { pos: Vec3; timestamp: number; tick: number }
type RawTrajectoryPoint = { pos: Vec3; vel: Vec3; tick: number }

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

class HighPrecisionVelocityTracker {
  private history: PositionSample[] = []
  private smoothedVel: Vec3 = new Vec3(0, 0, 0)

  record(pos: Vec3, timestamp: number, tick: number): void {
    this.history.push({ pos: pos.clone(), timestamp, tick })
    if (this.history.length > POSITION_HISTORY_SIZE) this.history.shift()
    this.updateSmoothedVelocity()
  }

  private updateSmoothedVelocity(): void {
    if (this.history.length < 2) return
    const newest = this.history[this.history.length - 1]!
    const oldest = this.history[0]!
    const dt = (newest.timestamp - oldest.timestamp) / 1000
    if (dt <= 0) return
    const rawVel = newest.pos.minus(oldest.pos).scaled(1 / dt)
    this.smoothedVel = this.smoothedVel
      .scaled(VELOCITY_SMOOTH_FACTOR)
      .add(rawVel.scaled(1 - VELOCITY_SMOOTH_FACTOR))
  }

  getVelocity(): Vec3 {
    return this.smoothedVel.clone()
  }

  reset(): void {
    this.history = []
    this.smoothedVel = new Vec3(0, 0, 0)
  }
}

class PreciseTargetPredictor {
  private readonly velTracker = new HighPrecisionVelocityTracker()
  private lastPos: Vec3 = new Vec3(0, 0, 0)
  private lastTimestamp: number = 0
  private tickOffset: number = 0
  private readonly accelerationEstimate: Vec3 = new Vec3(0, 0, 0)
  private accelerationAlpha = 0.3

  record(pos: Vec3, timestamp: number, tick: number): void {
    this.velTracker.record(pos, timestamp, tick)
    if (this.lastTimestamp > 0) {
      const dt = (timestamp - this.lastTimestamp) / 1000
      if (dt > 0) {
        const velDiff = this.velTracker.getVelocity().minus(this.lastPos.minus(pos).scaled(1 / dt))
        this.accelerationEstimate.x =
          this.accelerationAlpha * velDiff.x +
          (1 - this.accelerationAlpha) * this.accelerationEstimate.x
        this.accelerationEstimate.y =
          this.accelerationAlpha * velDiff.y +
          (1 - this.accelerationAlpha) * this.accelerationEstimate.y
        this.accelerationEstimate.z =
          this.accelerationAlpha * velDiff.z +
          (1 - this.accelerationAlpha) * this.accelerationEstimate.z
      }
    }
    this.lastPos = pos.clone()
    this.lastTimestamp = timestamp
    this.tickOffset = tick
  }

  predictFuturePosition(ticksAhead: number, bot?: Bot): Vec3 {
    const vel = this.velTracker.getVelocity()
    const acc = this.accelerationEstimate.clone()
    const startPos = this.lastPos.clone()
    const pos = startPos.clone()
    const v = vel.clone()
    const dtPerTick = 1 / 20
    for (let i = 0; i < ticksAhead; i++) {
      v.x += acc.x * dtPerTick
      v.y += acc.y * dtPerTick
      v.z += acc.z * dtPerTick
      if (bot) {
        const blockAtFeet = bot.blockAt(pos.offset(0, -0.1, 0))
        const inWater = blockAtFeet?.name === 'water' || blockAtFeet?.name === 'lava'
        if (inWater) {
          v.y -= 0.02
          v.y *= 0.8
          v.x *= 0.8
          v.z *= 0.8
        } else {
          v.y -= 0.08
          v.y *= 0.98
          const onGround = pos.y <= Math.floor(pos.y) + 0.2 && v.y <= 0
          if (onGround) {
            v.x *= 0.6
            v.z *= 0.6
            if (Math.abs(v.x) < 0.005) v.x = 0
            if (Math.abs(v.z) < 0.005) v.z = 0
          }
        }
      }
      pos.x += v.x * dtPerTick
      pos.y += v.y * dtPerTick
      pos.z += v.z * dtPerTick
    }
    return pos
  }

  getEstimatedVelocity(): Vec3 {
    return this.velTracker.getVelocity()
  }

  reset(): void {
    this.velTracker.reset()
    this.lastPos = new Vec3(0, 0, 0)
    this.lastTimestamp = 0
    this.accelerationEstimate.set(0, 0, 0)
  }
}

function simulateArrowPrecise(
  origin: Vec3,
  yaw: number,
  pitch: number,
  weaponName: string,
  maxTicks = MAX_FLIGHT_TICKS,
): RawTrajectoryPoint[] {
  const info = trajectoryInfo[weaponName] ?? trajectoryInfo['bow']!
  const cosPitch = Math.cos(pitch)
  const vel = new Vec3(
    -info.v0 * Math.sin(yaw) * cosPitch,
    info.v0 * Math.sin(pitch),
    info.v0 * Math.cos(yaw) * cosPitch,
  )
  const pos = origin.clone()
  const pts: RawTrajectoryPoint[] = []
  for (let t = 0; t < maxTicks; t++) {
    vel.y -= ARROW_GRAVITY
    vel.x *= ARROW_DRAG
    vel.y *= ARROW_DRAG
    vel.z *= ARROW_DRAG
    pos.x += vel.x
    pos.y += vel.y
    pos.z += vel.z
    pts.push({ pos: pos.clone(), vel: vel.clone(), tick: t + 1 })
    if (pos.y < -64) break
  }
  return pts
}

function aabbCollide(aMin: Vec3, aMax: Vec3, bMin: Vec3, bMax: Vec3): boolean {
  return (
    aMin.x < bMax.x &&
    aMax.x > bMin.x &&
    aMin.y < bMax.y &&
    aMax.y > bMin.y &&
    aMin.z < bMax.z &&
    aMax.z > bMin.z
  )
}

function computeMissDistance(
  yaw: number,
  pitch: number,
  origin: Vec3,
  targetFuturePositions: Vec3[],
  entityHeight: number,
  weaponName: string,
): { missDist: number; impactPos: Vec3; flightTicks: number } {
  const arrow = simulateArrowPrecise(origin, yaw, pitch, weaponName, targetFuturePositions.length)
  let minDist = Infinity
  let bestImpact = origin
  let bestTicks = 0
  for (let i = 0; i < arrow.length; i++) {
    const aPos = arrow[i]!.pos
    const tPos = targetFuturePositions[i]!
    const arrowMin = aPos.offset(-ARROW_SIZE / 2, -ARROW_SIZE / 2, -ARROW_SIZE / 2)
    const arrowMax = aPos.offset(ARROW_SIZE / 2, ARROW_SIZE / 2, ARROW_SIZE / 2)
    const targetMin = tPos.offset(-PLAYER_WIDTH / 2, 0, -PLAYER_WIDTH / 2)
    const targetMax = tPos.offset(PLAYER_WIDTH / 2, entityHeight, PLAYER_WIDTH / 2)
    if (aabbCollide(arrowMin, arrowMax, targetMin, targetMax)) {
      return { missDist: 0, impactPos: aPos.clone(), flightTicks: i + 1 }
    }
    const dx = Math.max(0, Math.abs(aPos.x - tPos.x) - (ARROW_SIZE / 2 + PLAYER_WIDTH / 2))
    const dy = Math.max(
      0,
      Math.abs(aPos.y - (tPos.y + entityHeight / 2)) - (ARROW_SIZE / 2 + entityHeight / 2),
    )
    const dz = Math.max(0, Math.abs(aPos.z - tPos.z) - (ARROW_SIZE / 2 + PLAYER_WIDTH / 2))
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (dist < minDist) {
      minDist = dist
      bestImpact = aPos.clone()
      bestTicks = i + 1
    }
  }
  return { missDist: minDist, impactPos: bestImpact, flightTicks: bestTicks }
}

function solveOptimalAim(
  origin: Vec3,
  targetStartPos: Vec3,
  predictor: PreciseTargetPredictor,
  entityHeight: number,
  weaponName: string,
  bot: Bot,
): { aim: SolvedAim; expectedMiss: number } | null {
  const maxTicks = MAX_FLIGHT_TICKS
  const futurePositions: Vec3[] = []
  for (let t = 0; t <= maxTicks; t++) {
    futurePositions.push(predictor.predictFuturePosition(t + LATENCY_TICKS + REACT_TICKS, bot))
  }

  const costFunc = (yaw: number, pitch: number) => {
    return computeMissDistance(yaw, pitch, origin, futurePositions, entityHeight, weaponName)
      .missDist
  }

  const roughDist = targetStartPos.distanceTo(origin)
  const roughTicks = Math.floor(roughDist / 3.0) + 8
  const initTarget = futurePositions[roughTicks]!.offset(0, entityHeight * 0.5, 0)
  const dx = initTarget.x - origin.x
  const dz = initTarget.z - origin.z
  const initYaw = Math.atan2(-dx, dz)

  let bestYaw = initYaw
  let bestPitch = 0
  let bestCost = Infinity

  const yawRange = 0.8
  for (let i = 0; i < OPT_GRID_STEPS; i++) {
    const yaw = initYaw - yawRange + (2 * yawRange * i) / (OPT_GRID_STEPS - 1)
    for (let j = 0; j < OPT_GRID_STEPS; j++) {
      const pitch = PITCH_LOWER + ((PITCH_UPPER - PITCH_LOWER) * j) / (OPT_GRID_STEPS - 1)
      const c = costFunc(yaw, pitch)
      if (c < bestCost) {
        bestCost = c
        bestYaw = yaw
        bestPitch = pitch
      }
    }
  }

  const simplex = (
    f: (x: number, y: number) => number,
    x0: number,
    y0: number,
    step: number,
    maxIter: number,
    tol: number,
  ) => {
    const points = [
      { x: x0, y: y0, fx: f(x0, y0) },
      { x: x0 + step, y: y0, fx: f(x0 + step, y0) },
      { x: x0, y: y0 + step, fx: f(x0, y0 + step) },
    ]
    const alpha = 1,
      gamma = 2,
      rho = 0.5,
      sigma = 0.5
    for (let iter = 0; iter < maxIter; iter++) {
      points.sort((a, b) => a.fx - b.fx)
      const best = points[0]!,
        good = points[1]!,
        worst = points[2]!
      const range = Math.abs(best.fx - worst.fx)
      if (range < tol) break
      const xc = (best.x + good.x) / 2
      const yc = (best.y + good.y) / 2
      const xr = xc + alpha * (xc - worst.x)
      const yr = yc + alpha * (yc - worst.y)
      const fxr = f(xr, yr)
      if (fxr < best.fx) {
        const xe = xc + gamma * (xr - xc)
        const ye = yc + gamma * (yr - yc)
        const fxe = f(xe, ye)
        points[2] = fxe < fxr ? { x: xe, y: ye, fx: fxe } : { x: xr, y: yr, fx: fxr }
      } else if (fxr < worst.fx) {
        points[2] = { x: xr, y: yr, fx: fxr }
      } else {
        const xcon = xc + rho * (worst.x - xc)
        const ycon = yc + rho * (worst.y - yc)
        const fxcon = f(xcon, ycon)
        if (fxcon < worst.fx) {
          points[2] = { x: xcon, y: ycon, fx: fxcon }
        } else {
          points[1] = {
            x: best.x + sigma * (good.x - best.x),
            y: best.y + sigma * (good.y - best.y),
            fx: f(best.x + sigma * (good.x - best.x), best.y + sigma * (good.y - best.y)),
          }
          points[2] = {
            x: best.x + sigma * (worst.x - best.x),
            y: best.y + sigma * (worst.y - best.y),
            fx: f(best.x + sigma * (worst.x - best.x), best.y + sigma * (worst.y - best.y)),
          }
        }
      }
    }
    points.sort((a, b) => a.fx - b.fx)
    return points[0]!
  }

  const refined = simplex(costFunc, bestYaw, bestPitch, 0.05, OPT_NM_ITER, OPT_NM_TOL)
  let finalYaw = refined.x
  let finalPitch = refined.y
  let finalCost = refined.fx

  for (let iter = 0; iter < OPT_LOCAL_STEPS; iter++) {
    const step = 0.005 / (iter + 1)
    const candidates: Array<[number, number]> = [
      [finalYaw, finalPitch],
      [finalYaw + step, finalPitch],
      [finalYaw - step, finalPitch],
      [finalYaw, finalPitch + step],
      [finalYaw, finalPitch - step],
    ]
    for (const [y, p] of candidates) {
      const clampedPitch = Math.min(PITCH_UPPER, Math.max(PITCH_LOWER, p))
      const c = costFunc(y, clampedPitch)
      if (c < finalCost) {
        finalCost = c
        finalYaw = y
        finalPitch = clampedPitch
      }
    }
  }

  const finalRes = computeMissDistance(
    finalYaw,
    finalPitch,
    origin,
    futurePositions,
    entityHeight,
    weaponName,
  )
  return {
    aim: {
      yaw: finalYaw,
      pitch: finalPitch,
      flightTicks: finalRes.flightTicks,
      impactPosition: finalRes.impactPos,
    },
    expectedMiss: finalRes.missDist,
  }
}

function detectBridgeInfo(bot: Bot, target: Entity): { edgeDir: Vec3; bridgeAxis: Vec3 } | null {
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
      bestDir = dir
    }
  }
  if (bestDrop < 3) return null
  const perp = new Vec3(-bestDir!.z, 0, bestDir!.x)
  return { edgeDir: bestDir!, bridgeAxis: perp }
}

export class BowAiming {
  private readonly predictor = new PreciseTargetPredictor()
  private tick = 0
  private lastTargetId: number | null = null
  private pendingShot: {
    target: Entity
    predictedAim: SolvedAim
    expectedMiss: number
    weaponName: string
    knockbackDir?: Vec3
    shotTick: number
  } | null = null

  constructor(private readonly config: BowConfig) {}

  compute(bot: Bot, target: Entity, weaponName: string): AimResult | null {
    this.tick++
    const now = performance.now()
    if (this.lastTargetId !== target.id) {
      this.predictor.reset()
      this.lastTargetId = target.id
    }
    this.predictor.record(target.position.clone(), now, this.tick)

    const eyePos = bot.entity.position.offset(0, 1.62, 0)
    let targetPos = target.position.clone()
    let knockbackDir: Vec3 | undefined = undefined
    if (this.config.bridgeKnockbackEnabled) {
      const bridgeInfo = detectBridgeInfo(bot, target)
      if (bridgeInfo) {
        knockbackDir = bridgeInfo.edgeDir
        targetPos = targetPos.plus(bridgeInfo.edgeDir.scaled(0.7))
      }
    }

    const solution = solveOptimalAim(
      eyePos,
      targetPos,
      this.predictor,
      target.height,
      weaponName,
      bot,
    )
    if (!solution) return null

    this.pendingShot = {
      target,
      predictedAim: solution.aim,
      expectedMiss: solution.expectedMiss,
      weaponName,
      ...(knockbackDir ? { knockbackDir } : {}),
      shotTick: this.tick,
    }

    debugLog('Aim computed', {
      yaw: solution.aim.yaw,
      pitch: solution.aim.pitch,
      expectedMiss: solution.expectedMiss,
      flightTicks: solution.aim.flightTicks,
    })

    return {
      ...solution.aim,
      weaponName,
      ...(knockbackDir ? { knockbackDir } : {}),
    }
  }

  recordShotResult(hit: boolean, actualImpactTick?: number): void {
    if (!this.pendingShot) return
    const { target, predictedAim, expectedMiss, knockbackDir } = this.pendingShot
    const actualPos = target.position.clone()
    const actualVel = this.predictor.getEstimatedVelocity()
    const actualMissDist = hit ? 0 : actualPos.distanceTo(predictedAim.impactPosition)
    const debugInfo: ShotDebugInfo = {
      timestamp: Date.now(),
      targetId: target.id,
      predictedYaw: predictedAim.yaw,
      predictedPitch: predictedAim.pitch,
      predictedFlightTicks: predictedAim.flightTicks,
      predictedImpactPos: predictedAim.impactPosition.clone(),
      expectedMissDist: expectedMiss,
      actualHit: hit,
      actualMissDist: actualMissDist,
      actualImpactTick: actualImpactTick ?? predictedAim.flightTicks,
      actualTargetPosAtImpact: actualPos,
      targetVelocity: actualVel,
      regime: 'interpolated',
      scenariosUsed: 1,
      ...(knockbackDir ? { knockbackDir: knockbackDir.clone() } : {}),
    }
    shotHistory.push(debugInfo)
    if (shotHistory.length > MAX_HISTORY) shotHistory.shift()
    debugLog('Shot result recorded', {
      hit,
      expectedMiss,
      actualMiss: actualMissDist,
      targetId: target.id,
    })
    this.pendingShot = null
  }

  reset(): void {
    this.predictor.reset()
    this.lastTargetId = null
    this.pendingShot = null
  }
}
