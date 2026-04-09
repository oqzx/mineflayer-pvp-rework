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

const REACT_TICKS = 5
const HISTORY_SIZE = 12
const BRIDGE_CHECK_DEPTH = 6
const BRIDGE_SIDE_CHECK = 1.6
const MAX_FLIGHT_TICKS = 200
const COARSE_YAW_STEPS = 24
const COARSE_PITCH_STEPS = 24
const BRENT_ITERS = 50
const LEAD_ITERS = 20
const HIT_EPSILON = 0.1
const MARKOV_ALPHA = 0.18
const KALMAN_PROCESS_NOISE = 0.004
const KALMAN_MEASURE_NOISE = 0.012
const PITCH_LOWER = -Math.PI * 0.44
const PITCH_UPPER = Math.PI * 0.22

type PositionSample = { pos: Vec3; vel: Vec3; tick: number }
type MovementRegime = 'straight' | 'strafing' | 'jumping' | 'sprint_jumping' | 'dodging' | 'idle'
type MarkovState = 'left' | 'right' | 'none'
type MarkovTransitions = Record<MarkovState, Record<MarkovState, number>>
type Scenario = { weight: number; vel: Vec3; acc: Vec3 }

function log(...args: any[]): void {
  console.log('[BowAiming]', ...args)
}

function identityP(n: number): number[][] {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  )
}

function matMul(A: number[][], B: number[][]): number[][] {
  const m = A.length
  const k = B.length
  const n = B[0]!.length
  const C = Array.from({ length: m }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      for (let l = 0; l < k; l++) {
        C[i]![j]! += A[i]![l]! * B[l]![j]!
      }
    }
  }
  return C
}

function matAdd(A: number[][], B: number[][]): number[][] {
  return A.map((row, i) => row.map((v, j) => v + B[i]![j]!))
}

function matSub(A: number[][], B: number[][]): number[][] {
  return A.map((row, i) => row.map((v, j) => v - B[i]![j]!))
}

function matTranspose(A: number[][]): number[][] {
  return A[0]!.map((_, j) => A.map((row) => row[j]!))
}

function mat3x3Inv(M: number[][]): number[][] {
  const a = M[0]![0]!
  const b = M[0]![1]!
  const c = M[0]![2]!
  const d = M[1]![0]!
  const e = M[1]![1]!
  const f = M[1]![2]!
  const g = M[2]![0]!
  const h = M[2]![1]!
  const ii = M[2]![2]!
  const det = a * (e * ii - f * h) - b * (d * ii - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-12) return identityP(3)
  return [
    [(e * ii - f * h) / det, (c * h - b * ii) / det, (b * f - c * e) / det],
    [(f * g - d * ii) / det, (a * ii - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ]
}

function scalarMulMat(s: number, A: number[][]): number[][] {
  return A.map((row) => row.map((v) => v * s))
}

class KalmanFilter9D {
  private px = 0
  private py = 0
  private pz = 0
  private vx = 0
  private vy = 0
  private vz = 0
  private ax = 0
  private ay = 0
  private az = 0
  private P: number[][] = identityP(9)

  init(pos: Vec3): void {
    this.px = pos.x
    this.py = pos.y
    this.pz = pos.z
    this.vx = 0
    this.vy = 0
    this.vz = 0
    this.ax = 0
    this.ay = 0
    this.az = 0
    this.P = identityP(9)
  }

  update(pos: Vec3): void {
    const dt = 1
    const pxP = this.px + this.vx * dt + 0.5 * this.ax * dt * dt
    const pyP = this.py + this.vy * dt + 0.5 * this.ay * dt * dt
    const pzP = this.pz + this.vz * dt + 0.5 * this.az * dt * dt
    const vxP = this.vx + this.ax * dt
    const vyP = this.vy + this.ay * dt
    const vzP = this.vz + this.az * dt

    const F: number[][] = [
      [1, 0, 0, dt, 0, 0, 0.5 * dt * dt, 0, 0],
      [0, 1, 0, 0, dt, 0, 0, 0.5 * dt * dt, 0],
      [0, 0, 1, 0, 0, dt, 0, 0, 0.5 * dt * dt],
      [0, 0, 0, 1, 0, 0, dt, 0, 0],
      [0, 0, 0, 0, 1, 0, 0, dt, 0],
      [0, 0, 0, 0, 0, 1, 0, 0, dt],
      [0, 0, 0, 0, 0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 1, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 1],
    ]

    const Q = scalarMulMat(KALMAN_PROCESS_NOISE, identityP(9))
    const PP = matAdd(matMul(matMul(F, this.P), matTranspose(F)), Q)

    const H: number[][] = [
      [1, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 1, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0, 0, 0, 0],
    ]

    const S = matAdd(
      matMul(matMul(H, PP), matTranspose(H)),
      scalarMulMat(KALMAN_MEASURE_NOISE, identityP(3))
    )
    const K = matMul(matMul(PP, matTranspose(H)), mat3x3Inv(S))

    const innov = matSub([[pos.x], [pos.y], [pos.z]], [[pxP], [pyP], [pzP]])
    const delta = matMul(K, innov)

    this.px = pxP + delta[0]![0]!
    this.py = pyP + delta[1]![0]!
    this.pz = pzP + delta[2]![0]!
    this.vx = vxP + delta[3]![0]!
    this.vy = vyP + delta[4]![0]!
    this.vz = vzP + delta[5]![0]!
    this.ax += delta[6]![0]!
    this.ay += delta[7]![0]!
    this.az += delta[8]![0]!
    this.P = matMul(matSub(identityP(9), matMul(K, H)), PP)
  }

  getPosition(): Vec3 {
    return new Vec3(this.px, this.py, this.pz)
  }

  getVelocity(): Vec3 {
    return new Vec3(this.vx, this.vy, this.vz)
  }

  getAcceleration(): Vec3 {
    return new Vec3(this.ax, this.ay, this.az)
  }

  predictAhead(ticks: number): Vec3 {
    const t = ticks
    return new Vec3(
      this.px + this.vx * t + 0.5 * this.ax * t * t,
      this.py + this.vy * t + 0.5 * this.ay * t * t,
      this.pz + this.vz * t + 0.5 * this.az * t * t
    )
  }
}

function initTransitions(): MarkovTransitions {
  const u = { left: 1 / 3, right: 1 / 3, none: 1 / 3 }
  return { left: { ...u }, right: { ...u }, none: { ...u } }
}

function normalizeRow(row: Record<MarkovState, number>): void {
  const sum = row.left + row.right + row.none
  if (sum < 1e-9) {
    row.left = row.right = row.none = 1 / 3
    return
  }
  row.left /= sum
  row.right /= sum
  row.none /= sum
}

class MovementPredictor {
  private readonly history: PositionSample[] = []
  private readonly kalman = new KalmanFilter9D()
  private initialized = false
  private regime: MovementRegime = 'idle'
  private markovState: MarkovState = 'none'
  private markov: MarkovTransitions = initTransitions()
  private directionChangeTicks: number[] = []
  private isGrounded = true
  private ticksSinceJump = 0
  private jumpStartY = 0
  private sprintJumpPeriod = 0

  record(pos: Vec3, vel: Vec3, tick: number): void {
    if (!this.initialized) {
      this.kalman.init(pos)
      this.initialized = true
    } else {
      this.kalman.update(pos)
    }

    const prev = this.history[this.history.length - 1]
    if (prev) {
      const prevState = this.markovState
      const side = this.classifySide(vel, prev.vel, pos, prev.pos)

      if (side !== prevState) {
        this.directionChangeTicks.push(tick)
        if (this.directionChangeTicks.length > 20) this.directionChangeTicks.shift()
        const row = this.markov[prevState]
        row[side] = row[side] * (1 - MARKOV_ALPHA) + MARKOV_ALPHA
        const others = (['left', 'right', 'none'] as MarkovState[]).filter((s) => s !== side)
        const complement = 1 - row[side]
        others.forEach((s) => {
          row[s] = complement * 0.5
        })
        normalizeRow(row)
      }

      this.markovState = side

      const wasGrounded = this.isGrounded
      this.isGrounded = vel.y <= 0.01 && Math.abs(vel.y) < 0.42
      if (!wasGrounded && this.isGrounded) {
        const elapsed = tick - this.ticksSinceJump
        if (elapsed > 0) {
          this.sprintJumpPeriod = this.sprintJumpPeriod * 0.7 + elapsed * 0.3
        }
      }
      if (!this.isGrounded && wasGrounded) {
        this.jumpStartY = pos.y
        this.ticksSinceJump = tick
      }

      const lateralVel = Math.sqrt(vel.x * vel.x + vel.z * vel.z)
      this.regime = this.classifyRegime(vel, lateralVel)
    }

    this.history.push({ pos: pos.clone(), vel: vel.clone(), tick })
    if (this.history.length > HISTORY_SIZE) this.history.shift()
  }

  private classifySide(vel: Vec3, prevVel: Vec3, pos: Vec3, prevPos: Vec3): MarkovState {
    const mag = Math.sqrt(vel.x * vel.x + vel.z * vel.z)
    if (mag < 0.02) return 'none'
    const rightX = vel.z / mag
    const rightZ = -vel.x / mag
    const lateralDelta = (pos.x - prevPos.x) * rightX + (pos.z - prevPos.z) * rightZ
    if (Math.abs(lateralDelta) < 0.01) return 'none'
    return lateralDelta > 0 ? 'right' : 'left'
  }

  private classifyRegime(vel: Vec3, lateralVel: number): MovementRegime {
    const spd = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z)
    if (spd < 0.02) return 'idle'
    if (!this.isGrounded && vel.y > 0.1) {
      if (this.sprintJumpPeriod > 3 && this.sprintJumpPeriod < 10) return 'sprint_jumping'
      return 'jumping'
    }
    const dc = this.directionChangeTicks
    if (dc.length >= 3) {
      if (dc[dc.length - 1]! - dc[dc.length - 3]! < 12) return 'dodging'
    }
    if (lateralVel > 0.12) return 'strafing'
    return 'straight'
  }

  buildScenarios(flightTicks: number): Scenario[] {
    const kVel = this.kalman.getVelocity()
    const kAcc = this.kalman.getAcceleration()
    const t = this.markov[this.markovState]
    const hSpd = Math.sqrt(kVel.x * kVel.x + kVel.z * kVel.z)
    const strafeVec =
      hSpd > 0.01 ? new Vec3(-kVel.z / hSpd, 0, kVel.x / hSpd) : new Vec3(1, 0, 0)
    const sSpd = 0.22
    let scenarios: Scenario[]

    switch (this.regime) {
      case 'idle':
        scenarios = [{ weight: 1, vel: new Vec3(0, 0, 0), acc: new Vec3(0, 0, 0) }]
        break
      case 'straight':
        scenarios = [
          { weight: 0.7, vel: kVel.clone(), acc: kAcc.clone() },
          { weight: 0.15, vel: kVel.scaled(0.5), acc: new Vec3(0, 0, 0) },
          { weight: 0.15, vel: new Vec3(0, 0, 0), acc: new Vec3(0, 0, 0) },
        ]
        break
      case 'strafing': {
        const lv = strafeVec.scaled(-sSpd)
        const rv = strafeVec.scaled(sSpd)
        const wC = Math.max(0, 1 - t.left - t.right) * 0.7
        const wL = t.left * 0.9
        const wR = t.right * 0.9
        const wS = 0.1
        const total = wC + wL + wR + wS || 1
        scenarios =
          this.markovState === 'left'
            ? [
                { weight: wC / total, vel: lv, acc: kAcc.clone() },
                { weight: wR / total, vel: rv, acc: new Vec3(0, 0, 0) },
                { weight: wL / total, vel: lv.scaled(0.5), acc: new Vec3(0, 0, 0) },
                { weight: wS / total, vel: new Vec3(0, 0, 0), acc: new Vec3(0, 0, 0) },
              ]
            : [
                { weight: wC / total, vel: rv, acc: kAcc.clone() },
                { weight: wL / total, vel: lv, acc: new Vec3(0, 0, 0) },
                { weight: wR / total, vel: rv.scaled(0.5), acc: new Vec3(0, 0, 0) },
                { weight: wS / total, vel: new Vec3(0, 0, 0), acc: new Vec3(0, 0, 0) },
              ]
        break
      }
      case 'jumping': {
        const apex = Math.max(0, this.jumpStartY + 1.25 - this.kalman.getPosition().y)
        const tApex = apex > 0 ? Math.sqrt((2 * apex) / 0.08) : 0
        const postVy = -0.08 * Math.max(0, flightTicks - tApex)
        scenarios = [
          { weight: 0.8, vel: new Vec3(kVel.x, postVy, kVel.z), acc: new Vec3(0, -0.04, 0) },
          { weight: 0.2, vel: kVel.clone(), acc: kAcc.clone() },
        ]
        break
      }
      case 'sprint_jumping': {
        const cycleT = this.sprintJumpPeriod > 0 ? flightTicks % this.sprintJumpPeriod : 0
        const inJump = cycleT < this.sprintJumpPeriod * 0.5
        scenarios = [
          { weight: 0.7, vel: kVel.scaled(inJump ? 1.3 : 1.0), acc: kAcc.clone() },
          { weight: 0.2, vel: kVel.clone(), acc: new Vec3(0, 0, 0) },
          { weight: 0.1, vel: new Vec3(0, 0, 0), acc: new Vec3(0, 0, 0) },
        ]
        break
      }
      case 'dodging': {
        const lv = strafeVec.scaled(-sSpd * 1.1)
        const rv = strafeVec.scaled(sSpd * 1.1)
        const reactCont = kVel.scaled(Math.min(1, REACT_TICKS / Math.max(1, flightTicks)))
        scenarios = [
          { weight: t.left * 0.8, vel: lv, acc: new Vec3(0, 0, 0) },
          { weight: t.right * 0.8, vel: rv, acc: new Vec3(0, 0, 0) },
          { weight: t.none * 0.6, vel: kVel.clone(), acc: kAcc.clone() },
          { weight: 0.2, vel: reactCont, acc: new Vec3(0, 0, 0) },
        ]
        break
      }
      default:
        scenarios = [{ weight: 1, vel: kVel.clone(), acc: kAcc.clone() }]
    }

    const totalW = scenarios.reduce((s, sc) => s + sc.weight, 0)
    if (totalW > 0) scenarios.forEach((sc) => (sc.weight /= totalW))
    return scenarios
  }

  getKalmanPosition(): Vec3 {
    return this.kalman.getPosition()
  }

  getKalmanVelocity(): Vec3 {
    return this.kalman.getVelocity()
  }

  reset(): void {
    this.history.length = 0
    this.initialized = false
    this.regime = 'idle'
    this.markovState = 'none'
    this.markov = initTransitions()
    this.directionChangeTicks.length = 0
    this.sprintJumpPeriod = 0
  }
}

function getEntityVelocity(bot: Bot, entity: Entity): Vec3 {
  return (
    (bot as unknown as { tracker?: { getEntitySpeed(e: Entity): Vec3 | null } }).tracker?.getEntitySpeed(
      entity
    ) ?? new Vec3(0, 0, 0)
  )
}

type RawTrajectoryPoint = { pos: Vec3; vel: Vec3; tick: number }

function simulateExact(
  origin: Vec3,
  yaw: number,
  pitch: number,
  weaponName: string,
  maxTicks: number = MAX_FLIGHT_TICKS
): RawTrajectoryPoint[] {
  const info = trajectoryInfo[weaponName] ?? trajectoryInfo['bow']!
  const PI = Math.PI
  // Minecraft yaw: 0 = south, positive = clockwise. Convert to standard math: 0 = east, positive = counter-clockwise.
  const theta = yaw + PI / 2
  const cosPitch = Math.cos(pitch)
  const vel = new Vec3(
    info.v0 * Math.cos(theta) * cosPitch,
    info.v0 * Math.sin(pitch),
    info.v0 * Math.sin(theta) * cosPitch
  )
  const pos = origin.clone()
  const pts: RawTrajectoryPoint[] = []

  for (let t = 0; t < maxTicks; t++) {
    vel.y -= info.g
    vel.x *= info.drag
    vel.y *= info.drag
    vel.z *= info.drag
    pos.x += vel.x
    pos.y += vel.y
    pos.z += vel.z
    pts.push({ pos: pos.clone(), vel: vel.clone(), tick: t + 1 })
    if (pos.y < -64) break
  }
  return pts
}

function computeWeightedMiss(
  yaw: number,
  pitch: number,
  origin: Vec3,
  scenarios: Scenario[],
  basePos: Vec3,
  entityHeight: number,
  weaponName: string
): number {
  const pts = simulateExact(origin, yaw, pitch, weaponName)
  let totalMiss = 0
  for (const sc of scenarios) {
    let bestDist = Infinity
    for (const pt of pts) {
      const targetPos = basePos
        .offset(0, entityHeight * 0.5, 0)
        .offset(
          sc.vel.x * pt.tick + 0.5 * sc.acc.x * pt.tick * pt.tick,
          sc.vel.y * pt.tick + 0.5 * sc.acc.y * pt.tick * pt.tick,
          sc.vel.z * pt.tick + 0.5 * sc.acc.z * pt.tick * pt.tick
        )
      const dist = pt.pos.distanceTo(targetPos)
      if (dist < bestDist) bestDist = dist
    }
    totalMiss += sc.weight * bestDist
  }
  return totalMiss
}

function brentMin(
  f: (x: number) => number,
  lo: number,
  hi: number,
  iters: number,
  tol: number
): { x: number; fx: number } {
  const GOLD = 0.3819660112501051
  let a = lo
  let b = hi
  let x = a + GOLD * (b - a)
  let w = x
  let v = x
  let fx = f(x)
  let fw = fx
  let fv = fx
  let d = 0
  let e = 0

  for (let i = 0; i < iters; i++) {
    const mid = 0.5 * (a + b)
    const tol1 = tol * Math.abs(x) + 1e-10
    if (Math.abs(x - mid) <= 2 * tol1 - 0.5 * (b - a)) break

    let useP = false
    let p = 0
    let q = 0
    let r = 0
    if (Math.abs(e) > tol1) {
      r = (x - w) * (fx - fv)
      q = (x - v) * (fx - fw)
      p = (x - v) * q - (x - w) * r
      q = 2 * (q - r)
      if (q > 0) p = -p
      else q = -q
      r = e
      e = d
      if (Math.abs(p) < Math.abs(0.5 * q * r) && p > q * (a - x) && p < q * (b - x)) {
        d = p / q
        useP = true
        if (x + d - a < 2 * tol1 || b - (x + d) < 2 * tol1) {
          d = mid > x ? tol1 : -tol1
        }
      }
    }
    if (!useP) {
      e = (x < mid ? b : a) - x
      d = GOLD * e
    }
    const u = Math.abs(d) >= tol1 ? x + d : x + (d > 0 ? tol1 : -tol1)
    const fu = f(u)
    if (fu <= fx) {
      if (u < x) b = x
      else a = x
      v = w
      fv = fw
      w = x
      fw = fx
      x = u
      fx = fu
    } else {
      if (u < x) a = u
      else b = u
      if (fu <= fw || w === x) {
        v = w
        fv = fw
        w = u
        fw = fu
      } else if (fu <= fv || v === x || v === w) {
        v = u
        fv = fu
      }
    }
  }
  return { x, fx }
}

function optimizeAngles(
  origin: Vec3,
  scenarios: Scenario[],
  basePos: Vec3,
  entityHeight: number,
  weaponName: string
): { yaw: number; pitch: number } | null {
  const primary = scenarios[0]!
  const guessTarget = basePos
    .offset(0, entityHeight * 0.5, 0)
    .offset(primary.vel.x * 10, primary.vel.y * 10, primary.vel.z * 10)

  const dx = guessTarget.x - origin.x
  const dz = guessTarget.z - origin.z
  const directYaw = Math.atan2(dx, dz)   // atan2(dx, dz) gives angle from positive Z axis towards positive X (standard math)

  log('optimizeAngles: origin', origin, 'guessTarget', guessTarget)
  log('  directYaw (rad)', directYaw, 'deg', directYaw * 180 / Math.PI)

  let bestYaw = directYaw
  let bestPitch = 0
  let bestCost = Infinity

  const yawSweep = 0.5
  const pitchSweep = 0.4
  for (let yi = 0; yi <= COARSE_YAW_STEPS; yi++) {
    const testYaw = directYaw - yawSweep + yi * ((yawSweep * 2) / COARSE_YAW_STEPS)
    for (let pi = 0; pi <= COARSE_PITCH_STEPS; pi++) {
      const testPitch = PITCH_LOWER + pi * ((PITCH_UPPER - PITCH_LOWER) / COARSE_PITCH_STEPS)
      const cost = computeWeightedMiss(
        testYaw,
        testPitch,
        origin,
        scenarios,
        basePos,
        entityHeight,
        weaponName
      )
      if (cost < bestCost) {
        bestCost = cost
        bestYaw = testYaw
        bestPitch = testPitch
      }
    }
  }
  log('  coarse best: yaw', bestYaw, 'pitch', bestPitch, 'cost', bestCost)

  const costFunc = (yaw: number, pitch: number) =>
    computeWeightedMiss(yaw, pitch, origin, scenarios, basePos, entityHeight, weaponName)

  for (let iter = 0; iter < 3; iter++) {
    const yawOpt = brentMin(
      (yaw) => costFunc(yaw, bestPitch),
      bestYaw - 0.3,
      bestYaw + 0.3,
      BRENT_ITERS,
      1e-4
    )
    bestYaw = yawOpt.x
    const pitchOpt = brentMin(
      (pitch) => costFunc(bestYaw, pitch),
      Math.max(PITCH_LOWER, bestPitch - 0.25),
      Math.min(PITCH_UPPER, bestPitch + 0.25),
      BRENT_ITERS,
      1e-4
    )
    bestPitch = pitchOpt.x
    log(`  refine iter ${iter}: yaw`, bestYaw, 'pitch', bestPitch, 'cost', pitchOpt.fx)
    if (pitchOpt.fx < HIT_EPSILON) break
  }

  const finalCost = costFunc(bestYaw, bestPitch)
  log('  final cost:', finalCost)
  if (finalCost > 2.5) {
    log('  cost too high, returning null')
    return null
  }
  return { yaw: bestYaw, pitch: bestPitch }
}

function solveOptimalAim(
  origin: Vec3,
  scenarios: Scenario[],
  basePos: Vec3,
  entityHeight: number,
  weaponName: string
): SolvedAim | null {
  log('=== solveOptimalAim ===')
  log('origin:', origin)
  log('basePos:', basePos)
  log('entityHeight:', entityHeight)
  log('scenarios:', scenarios.map(s => ({ w: s.weight, v: s.vel, a: s.acc })))

  let refinedScenarios = scenarios
  let bestSolution: SolvedAim | null = null
  let prevTargetPos: Vec3 | null = null
  const DAMPING = 0.6

  for (let iter = 0; iter < LEAD_ITERS; iter++) {
    log(`Lead iteration ${iter}`)
    const angles = optimizeAngles(origin, refinedScenarios, basePos, entityHeight, weaponName)
    if (!angles) break

    const pts = simulateExact(origin, angles.yaw, angles.pitch, weaponName)
    const primary = refinedScenarios[0]!

    let bestDist = Infinity
    let bestTick = 0
    let bestPt: RawTrajectoryPoint | null = null
    let bestTargetPos: Vec3 | null = null

    for (const pt of pts) {
      const targetPos = basePos
        .offset(0, entityHeight * 0.5, 0)
        .offset(
          primary.vel.x * pt.tick + 0.5 * primary.acc.x * pt.tick * pt.tick,
          primary.vel.y * pt.tick + 0.5 * primary.acc.y * pt.tick * pt.tick,
          primary.vel.z * pt.tick + 0.5 * primary.acc.z * pt.tick * pt.tick
        )
      const dist = pt.pos.distanceTo(targetPos)
      if (dist < bestDist) {
        bestDist = dist
        bestTick = pt.tick
        bestPt = pt
        bestTargetPos = targetPos
      }
    }

    log(`  bestTick: ${bestTick}, dist: ${bestDist}`)
    log(`  projectile at tick ${bestTick}:`, bestPt?.pos)
    log(`  predicted target at tick ${bestTick}:`, bestTargetPos)

    bestSolution = {
      yaw: angles.yaw,
      pitch: angles.pitch,
      flightTicks: bestTick,
      impactPosition: bestPt?.pos.clone() ?? basePos.offset(0, entityHeight * 0.5, 0),
    }

    if (bestDist < HIT_EPSILON) {
      log('  hit epsilon reached, breaking')
      break
    }

    if (prevTargetPos) {
      const dampedTarget = bestTargetPos!.scaled(1 - DAMPING).add(prevTargetPos.scaled(DAMPING))
      log('  damped target update:', dampedTarget)
      refinedScenarios = [{
        ...primary,
        vel: dampedTarget.sub(basePos).scaled(1 / bestTick),
        acc: primary.acc,
      }]
      basePos = dampedTarget.clone()
    } else {
      refinedScenarios = [{
        ...primary,
        vel: bestTargetPos!.sub(basePos).scaled(1 / bestTick),
        acc: primary.acc,
      }]
    }
    prevTargetPos = bestTargetPos
  }

  log('final solution:', bestSolution)
  return bestSolution
}

function detectBridgeInfo(bot: Bot, target: Entity): { edgeDir: Vec3; bridgeAxis: Vec3 } | null {
  const tp = target.position
  const cardinals = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  const openDirs: Vec3[] = []

  for (const dir of cardinals) {
    let groundFound = false
    for (let dy = -1; dy >= -BRIDGE_CHECK_DEPTH; dy--) {
      const block = bot.blockAt(tp.plus(dir.scaled(BRIDGE_SIDE_CHECK)).offset(0, dy, 0))
      if (block && block.name !== 'air') {
        groundFound = true
        break
      }
    }
    if (!groundFound) openDirs.push(dir)
  }
  if (openDirs.length === 0) return null

  const dropDepth = (dir: Vec3): number => {
    let d = 0
    for (let dy = -1; dy >= -10; dy--) {
      const b = bot.blockAt(tp.plus(dir.scaled(2.5)).offset(0, dy, 0))
      if (b && b.name !== 'air') break
      d++
    }
    return d
  }

  const bestDir = openDirs.reduce((best, dir) => (dropDepth(dir) >= dropDepth(best) ? dir : best), openDirs[0]!)
  const perp = cardinals.filter((d) => Math.abs(d.x * bestDir.x + d.z * bestDir.z) < 0.1)
  const bridgeAxis = perp.length > 0 ? perp[0]! : new Vec3(-bestDir.z, 0, bestDir.x)
  return { edgeDir: bestDir, bridgeAxis }
}

function computeKnockbackAim(
  origin: Vec3,
  targetPos: Vec3,
  entityHeight: number,
  entityVel: Vec3,
  edgeDir: Vec3,
  weaponName: string
): SolvedAim | null {
  const desiredKb = edgeDir.clone().normalize()
  const offsetTarget = targetPos.plus(edgeDir.scaled(0.7))
  const scenarios: Scenario[] = [{ weight: 1, vel: entityVel.clone(), acc: new Vec3(0, 0, 0) }]

  const baseAim = solveOptimalAim(origin, scenarios, offsetTarget, entityHeight, weaponName)
  if (!baseAim) return null

  const impactPts = simulateExact(origin, baseAim.yaw, baseAim.pitch, weaponName)
  const impactPt = impactPts[baseAim.flightTicks - 1]
  if (!impactPt) return baseAim

  const iv = impactPt.vel
  const iMag = Math.sqrt(iv.x * iv.x + iv.y * iv.y + iv.z * iv.z)
  if (iMag < 1e-6) return baseAim
  const kbDot = (iv.x / iMag) * desiredKb.x + (iv.z / iMag) * desiredKb.z
  if (kbDot > 0.5) return baseAim

  const YAW_SWEEP = 0.6
  const PITCH_SWEEP = 0.2
  let bestScore = -Infinity
  let bestAim: SolvedAim = baseAim

  for (let yi = 0; yi <= 16; yi++) {
    const testYaw = baseAim.yaw - YAW_SWEEP + yi * ((YAW_SWEEP * 2) / 16)
    for (let pi = 0; pi <= 4; pi++) {
      const testPitch = baseAim.pitch - PITCH_SWEEP + pi * ((PITCH_SWEEP * 2) / 4)
      const pts = simulateExact(origin, testYaw, testPitch, weaponName)
      let bestTick = 0
      let bestDist = Infinity
      for (const pt of pts) {
        const d = pt.pos.distanceTo(offsetTarget)
        if (d < bestDist) {
          bestDist = d
          bestTick = pt.tick
        }
      }
      const pt = pts[bestTick - 1]
      if (!pt || bestDist > 1.5) continue
      const vMag = Math.sqrt(pt.vel.x * pt.vel.x + pt.vel.y * pt.vel.y + pt.vel.z * pt.vel.z)
      if (vMag < 1e-6) continue
      const score = (pt.vel.x / vMag) * desiredKb.x + (pt.vel.z / vMag) * desiredKb.z - bestDist * 0.5
      if (score > bestScore) {
        bestScore = score
        bestAim = { yaw: testYaw, pitch: testPitch, flightTicks: bestTick, impactPosition: pt.pos.clone() }
      }
    }
  }
  return bestAim
}

export class BowAiming {
  private readonly predictor = new MovementPredictor()
  private tick = 0
  private lastTargetId: number | null = null

  constructor(private readonly config: BowConfig) {}

  compute(bot: Bot, target: Entity, weaponName: string): AimResult | null {
    this.tick++
    if (this.lastTargetId !== target.id) {
      log('New target:', target.id, 'type:', target.name)
      this.predictor.reset()
      this.lastTargetId = target.id
    }

    const trackerVel = getEntityVelocity(bot, target)
    this.predictor.record(target.position.clone(), trackerVel, this.tick)

    // Use correct eye height for 1.8.8 (player eye is at feet + 1.62)
    const eyePos = bot.entity.position.offset(0, 1.62, 0)
    log(`Tick ${this.tick}: eyePos`, eyePos, 'targetPos', target.position, 'vel', trackerVel)

    if (this.config.bridgeKnockbackEnabled) {
      const bridgeInfo = detectBridgeInfo(bot, target)
      if (bridgeInfo) {
        log('Bridge detected, edgeDir:', bridgeInfo.edgeDir)
        const kbAim = computeKnockbackAim(
          eyePos,
          target.position,
          target.height,
          trackerVel,
          bridgeInfo.edgeDir,
          weaponName
        )
        if (kbAim) return { ...kbAim, weaponName, knockbackDir: bridgeInfo.edgeDir }
      }
    }

    const scenarios = this.predictor.buildScenarios(10)
    const basePos = this.predictor.getKalmanPosition()
    log('Kalman basePos:', basePos, 'vel:', this.predictor.getKalmanVelocity())

    const aim = solveOptimalAim(eyePos, scenarios, basePos, target.height, weaponName)
    if (!aim) {
      log('No aim solution found')
      return null
    }
    log('Final aim:', aim)
    return { ...aim, weaponName }
  }

  reset(): void {
    this.predictor.reset()
    this.lastTargetId = null
  }
}

export function computeKnockbackAimPublic(
  bot: Bot,
  target: Entity,
  edgeDir: Vec3,
  weaponName: string
): SolvedAim | null {
  const eyePos = bot.entity.position.offset(0, 1.62, 0)
  const vel = getEntityVelocity(bot, target)
  return computeKnockbackAim(eyePos, target.position, target.height, vel, edgeDir, weaponName)
}