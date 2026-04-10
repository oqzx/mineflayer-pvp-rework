// ============================================================
// STANDALONE BOW AIMING ALGORITHM + TEST SUITE (FIXED)
// Run with: ts-node this-file.ts
// ============================================================

// ---------- Vec3 ----------
class Vec3 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z)
  }
  plus(v: Vec3): Vec3 {
    return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z)
  }
  minus(v: Vec3): Vec3 {
    return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z)
  }
  sub(v: Vec3): Vec3 {
    return this.minus(v)
  }
  add(v: Vec3): Vec3 {
    this.x += v.x
    this.y += v.y
    this.z += v.z
    return this
  }
  scaled(s: number): Vec3 {
    return new Vec3(this.x * s, this.y * s, this.z * s)
  }
  offset(dx: number, dy: number, dz: number): Vec3 {
    return new Vec3(this.x + dx, this.y + dy, this.z + dz)
  }
  distanceTo(v: Vec3): number {
    const dx = this.x - v.x,
      dy = this.y - v.y,
      dz = this.z - v.z
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
  normalize(): Vec3 {
    const m = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z) || 1
    return new Vec3(this.x / m, this.y / m, this.z / m)
  }
  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z)
  }
}

// ---------- Types ----------
type Bot = {
  entity: { position: Vec3 }
  tracker?: { getEntitySpeed(e: Entity): Vec3 | null }
  blockAt(pos: Vec3): { name: string } | null
}

type Entity = {
  id: number
  position: Vec3
  height: number
  name: string
}

type BowConfig = { bridgeKnockbackEnabled: boolean }

const trajectoryInfo: Record<string, { v0: number; g: number; drag: number }> = {
  bow: { v0: 3.0, g: 0.05, drag: 0.99 },
  crossbow: { v0: 3.15, g: 0.05, drag: 0.99 },
}

// ============================================================
// MOVEMENT PREDICTION (Kalman + Markov) – unchanged from provided
// ============================================================

type SolvedAim = {
  yaw: number
  pitch: number
  flightTicks: number
  impactPosition: Vec3
}

type AimResult = SolvedAim & {
  weaponName: string
  knockbackDir?: Vec3
}

const REACT_TICKS = 5
const HISTORY_SIZE = 12
const BRIDGE_CHECK_DEPTH = 6
const BRIDGE_SIDE_CHECK = 1.6
const MAX_FLIGHT_TICKS = 200
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

function identityP(n: number): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
}

function matMul(A: number[][], B: number[][]): number[][] {
  const m = A.length,
    k = B.length,
    n = B[0]!.length
  const C = Array.from({ length: m }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < m; i++)
    for (let j = 0; j < n; j++) for (let l = 0; l < k; l++) C[i]![j]! += A[i]![l]! * B[l]![j]!
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
  const a = M[0]![0]!,
    b = M[0]![1]!,
    c = M[0]![2]!
  const d = M[1]![0]!,
    e = M[1]![1]!,
    f = M[1]![2]!
  const g = M[2]![0]!,
    h = M[2]![1]!,
    ii = M[2]![2]!
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
    this.vx = this.vy = this.vz = 0
    this.ax = this.ay = this.az = 0
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
      scalarMulMat(KALMAN_MEASURE_NOISE, identityP(3)),
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
    } else this.kalman.update(pos)

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
        if (elapsed > 0) this.sprintJumpPeriod = this.sprintJumpPeriod * 0.7 + elapsed * 0.3
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
    const rightX = vel.z / mag,
      rightZ = -vel.x / mag
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
    if (dc.length >= 3 && dc[dc.length - 1]! - dc[dc.length - 3]! < 12) return 'dodging'
    if (lateralVel > 0.12) return 'strafing'
    return 'straight'
  }

  buildScenarios(flightTicks: number): Scenario[] {
    const kVel = this.kalman.getVelocity()
    const kAcc = this.kalman.getAcceleration()
    const t = this.markov[this.markovState]
    const hSpd = Math.sqrt(kVel.x * kVel.x + kVel.z * kVel.z)
    const strafeVec = hSpd > 0.01 ? new Vec3(-kVel.z / hSpd, 0, kVel.x / hSpd) : new Vec3(1, 0, 0)
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
        const lv = strafeVec.scaled(-sSpd),
          rv = strafeVec.scaled(sSpd)
        const wC = Math.max(0, 1 - t.left - t.right) * 0.7
        const wL = t.left * 0.9,
          wR = t.right * 0.9,
          wS = 0.1
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
        const lv = strafeVec.scaled(-sSpd * 1.1),
          rv = strafeVec.scaled(sSpd * 1.1)
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
    (
      bot as Bot & { tracker?: { getEntitySpeed?: (tracked: Entity) => Vec3 } }
    ).tracker?.getEntitySpeed?.(entity) ?? new Vec3(0, 0, 0)
  )
}

// ============================================================
// ARROW SIMULATION & ROBUST SOLVER
// ============================================================

type RawTrajectoryPoint = { pos: Vec3; vel: Vec3; tick: number }

function simulateArrow(
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

// Exact player physics
function simulatePlayer(startPos: Vec3, startVel: Vec3, ticks: number): Vec3[] {
  const path: Vec3[] = []
  const pos = startPos.clone()
  const vel = startVel.clone()
  let onGround = startPos.y <= 0
  for (let t = 0; t < ticks; t++) {
    path.push(pos.clone())
    vel.y -= 0.08
    vel.y *= 0.98
    vel.x *= onGround ? 0.6 : 0.91
    vel.z *= onGround ? 0.6 : 0.91
    pos.x += vel.x
    pos.y += vel.y
    pos.z += vel.z
    if (pos.y <= 0) {
      pos.y = 0
      vel.y = 0
      onGround = true
    } else {
      onGround = false
    }
  }
  return path
}

function computeTrueMiss(
  yaw: number,
  pitch: number,
  origin: Vec3,
  targetPos: Vec3,
  targetVel: Vec3,
  entityHeight: number,
  weaponName: string,
): { dist: number; tick: number } {
  const arrow = simulateArrow(origin, yaw, pitch, weaponName)
  const targetPath = simulatePlayer(targetPos, targetVel, arrow.length)
  let bestDist = Infinity,
    bestTick = 0
  for (let i = 0; i < arrow.length; i++) {
    const arrowPos = arrow[i]!.pos
    const targetFeet = targetPath[i]!
    const targetCenter = targetFeet.offset(0, entityHeight * 0.5, 0)
    const d = arrowPos.distanceTo(targetCenter)
    if (d < bestDist) {
      bestDist = d
      bestTick = i + 1
    }
  }
  return { dist: bestDist, tick: bestTick }
}

// Nelder-Mead simplex optimizer for 2D
function nelderMead(
  f: (x: number, y: number) => number,
  x0: number,
  y0: number,
  initialStep: number = 0.1,
  maxIters: number = 100,
  tol: number = 1e-6,
): { x: number; y: number; fx: number } {
  const simplex: { x: number; y: number; fx: number }[] = [
    { x: x0, y: y0, fx: f(x0, y0) },
    { x: x0 + initialStep, y: y0, fx: f(x0 + initialStep, y0) },
    { x: x0, y: y0 + initialStep, fx: f(x0, y0 + initialStep) },
  ]
  const alpha = 1.0,
    gamma = 2.0,
    rho = 0.5,
    sigma = 0.5
  for (let iter = 0; iter < maxIters; iter++) {
    simplex.sort((a, b) => a.fx - b.fx)
    const best = simplex[0]!,
      good = simplex[1]!,
      worst = simplex[2]!
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
      if (fxe < fxr) {
        simplex[2] = { x: xe, y: ye, fx: fxe }
      } else {
        simplex[2] = { x: xr, y: yr, fx: fxr }
      }
    } else if (fxr < worst.fx) {
      simplex[2] = { x: xr, y: yr, fx: fxr }
    } else {
      const xcon = xc + rho * (worst.x - xc)
      const ycon = yc + rho * (worst.y - yc)
      const fxcon = f(xcon, ycon)
      if (fxcon < worst.fx) {
        simplex[2] = { x: xcon, y: ycon, fx: fxcon }
      } else {
        simplex[1] = {
          x: best.x + sigma * (good.x - best.x),
          y: best.y + sigma * (good.y - best.y),
          fx: f(best.x + sigma * (good.x - best.x), best.y + sigma * (good.y - best.y)),
        }
        simplex[2] = {
          x: best.x + sigma * (worst.x - best.x),
          y: best.y + sigma * (worst.y - best.y),
          fx: f(best.x + sigma * (worst.x - best.x), best.y + sigma * (worst.y - best.y)),
        }
      }
    }
    simplex[1]!.fx = f(simplex[1]!.x, simplex[1]!.y)
    simplex[2]!.fx = f(simplex[2]!.x, simplex[2]!.y)
  }
  simplex.sort((a, b) => a.fx - b.fx)
  return { x: simplex[0]!.x, y: simplex[0]!.y, fx: simplex[0]!.fx }
}

function solveOptimalAim(
  origin: Vec3,
  scenarios: Scenario[],
  basePos: Vec3,
  entityHeight: number,
  weaponName: string,
): SolvedAim | null {
  const targetVel = scenarios[0]!.vel
  const targetPos = basePos.clone()

  const costFunc = (yaw: number, pitch: number) => {
    return computeTrueMiss(yaw, pitch, origin, targetPos, targetVel, entityHeight, weaponName).dist
  }

  const gridSteps = 100
  let bestYaw = 0,
    bestPitch = 0,
    bestCost = Infinity

  const roughDist = targetPos.distanceTo(origin)
  const roughTicks = Math.floor(roughDist / 3.0) + 8
  const initPath = simulatePlayer(targetPos, targetVel, roughTicks + 1)
  const initTarget = initPath[roughTicks]!.offset(0, entityHeight * 0.5, 0)
  const dx = initTarget.x - origin.x
  const dz = initTarget.z - origin.z
  const initYaw = Math.atan2(-dx, dz)

  const yawRange = 0.8
  for (let i = 0; i < gridSteps; i++) {
    const yaw = initYaw - yawRange + (2 * yawRange * i) / (gridSteps - 1)
    for (let j = 0; j < gridSteps; j++) {
      const pitch = PITCH_LOWER + ((PITCH_UPPER - PITCH_LOWER) * j) / (gridSteps - 1)
      const c = costFunc(yaw, pitch)
      if (c < bestCost) {
        bestCost = c
        bestYaw = yaw
        bestPitch = pitch
      }
    }
  }

  const refined = nelderMead((y, p) => costFunc(y, p), bestYaw, bestPitch, 0.1, 120, 1e-7)

  let finalYaw = refined.x
  let finalPitch = refined.y

  // Additional local Brent-style refinement around the optimum
  for (let iter = 0; iter < 5; iter++) {
    const step = 0.03 / (iter + 1)
    const candidates: Array<[number, number]> = [
      [finalYaw, finalPitch],
      [finalYaw + step, finalPitch],
      [finalYaw - step, finalPitch],
      [finalYaw, finalPitch + step],
      [finalYaw, finalPitch - step],
      [finalYaw + step, finalPitch + step],
      [finalYaw - step, finalPitch - step],
    ]
    for (const [y, p] of candidates) {
      const c = costFunc(y, Math.min(PITCH_UPPER, Math.max(PITCH_LOWER, p)))
      if (c < refined.fx) {
        refined.fx = c
        finalYaw = y
        finalPitch = Math.min(PITCH_UPPER, Math.max(PITCH_LOWER, p))
      }
    }
  }

  const finalMiss = computeTrueMiss(
    finalYaw,
    finalPitch,
    origin,
    targetPos,
    targetVel,
    entityHeight,
    weaponName,
  )
  const arrow = simulateArrow(origin, finalYaw, finalPitch, weaponName)
  const impactPos = arrow[finalMiss.tick - 1]?.pos ?? origin

  return {
    yaw: finalYaw,
    pitch: finalPitch,
    flightTicks: finalMiss.tick,
    impactPosition: impactPos,
  }
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
  const bestDir = openDirs.reduce(
    (best, dir) => (dropDepth(dir) >= dropDepth(best) ? dir : best),
    openDirs[0]!,
  )
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
  weaponName: string,
): SolvedAim | null {
  const offsetTarget = targetPos.plus(edgeDir.scaled(0.7))
  const scenario: Scenario = { weight: 1, vel: entityVel.clone(), acc: new Vec3(0, 0, 0) }
  return solveOptimalAim(origin, [scenario], offsetTarget, entityHeight, weaponName)
}

class BowAiming {
  private readonly predictor = new MovementPredictor()
  private tick = 0
  private lastTargetId: number | null = null

  constructor(private readonly config: BowConfig) {}

  compute(bot: Bot, target: Entity, weaponName: string): AimResult | null {
    this.tick++
    if (this.lastTargetId !== target.id) {
      this.predictor.reset()
      this.lastTargetId = target.id
    }
    const trackerVel = getEntityVelocity(bot, target)
    this.predictor.record(target.position.clone(), trackerVel, this.tick)
    const eyePos = bot.entity.position.offset(0, 1.62, 0)

    if (this.config.bridgeKnockbackEnabled) {
      const bridgeInfo = detectBridgeInfo(bot, target)
      if (bridgeInfo) {
        const kbAim = computeKnockbackAim(
          eyePos,
          target.position,
          target.height,
          trackerVel,
          bridgeInfo.edgeDir,
          weaponName,
        )
        if (kbAim) return { ...kbAim, weaponName, knockbackDir: bridgeInfo.edgeDir }
      }
    }

    const scenarios = this.predictor.buildScenarios(10)
    const basePos = this.predictor.getKalmanPosition()
    const aim = solveOptimalAim(eyePos, scenarios, basePos, target.height, weaponName)
    if (!aim) return null
    return { ...aim, weaponName }
  }

  reset(): void {
    this.predictor.reset()
    this.lastTargetId = null
  }
}

// ============================================================
// TEST HARNESS (with corrected coordinate alignment)
// ============================================================

class MockBot implements Bot {
  entity = { position: new Vec3(0, 0, 0) } // feet position
  tracker = { getEntitySpeed: (e: Entity) => (e as MockEntity).velocity.clone() }
  blockAt(_pos: Vec3) {
    return null
  }
}

class MockEntity implements Entity {
  id: number
  position: Vec3
  velocity: Vec3 = new Vec3(0, 0, 0)
  height: number
  name = 'player'
  isSprinting = false
  isJumping = false
  onGround = true
  moveForward = 0
  moveStrafe = 0

  constructor(id: number, pos: Vec3, height: number) {
    this.id = id
    this.position = pos.clone()
    this.height = height
  }

  tick(): void {
    const speed = this.isSprinting ? 0.13 : 0.1
    let moveX = 0,
      moveZ = 0
    if (this.moveForward !== 0 || this.moveStrafe !== 0) {
      const yaw = 0
      const sin = Math.sin(yaw),
        cos = Math.cos(yaw)
      moveX = this.moveStrafe * cos - this.moveForward * sin
      moveZ = this.moveForward * cos + this.moveStrafe * sin
      const len = Math.sqrt(moveX * moveX + moveZ * moveZ)
      if (len > 0) {
        moveX = (moveX / len) * speed
        moveZ = (moveZ / len) * speed
      }
    }
    if (this.onGround && this.isJumping) {
      this.velocity.y = 0.42
      this.onGround = false
    }
    this.velocity.y -= 0.08
    this.velocity.y *= 0.98
    this.velocity.x *= this.onGround ? 0.6 : 0.91
    this.velocity.z *= this.onGround ? 0.6 : 0.91
    this.velocity.x += moveX
    this.velocity.z += moveZ
    this.position.x += this.velocity.x
    this.position.y += this.velocity.y
    this.position.z += this.velocity.z
    if (this.position.y <= 0) {
      this.position.y = 0
      this.velocity.y = 0
      this.onGround = true
    } else {
      this.onGround = false
    }
    this.isJumping = false
  }
}

interface TestCase {
  name: string
  shooterFeetPos: Vec3 // feet position of shooter
  targetStart: Vec3
  targetHeight: number
  setup: (e: MockEntity) => void
  ticksToSimulate: number
  weapon: string
}

const tests: TestCase[] = [
  {
    name: 'stationary same elevation 20m',
    shooterFeetPos: new Vec3(0, 0, 0),
    targetStart: new Vec3(20, 0, 0),
    targetHeight: 1.8,
    setup: () => {},
    ticksToSimulate: 40,
    weapon: 'bow',
  },
  {
    name: 'walking straight +Z',
    shooterFeetPos: new Vec3(0, 0, 0),
    targetStart: new Vec3(20, 0, 0),
    targetHeight: 1.8,
    setup: (e) => {
      e.moveForward = 1
    },
    ticksToSimulate: 40,
    weapon: 'bow',
  },
  {
    name: 'sprinting straight +Z',
    shooterFeetPos: new Vec3(0, 0, 0),
    targetStart: new Vec3(20, 0, 0),
    targetHeight: 1.8,
    setup: (e) => {
      e.moveForward = 1
      e.isSprinting = true
    },
    ticksToSimulate: 40,
    weapon: 'bow',
  },
  {
    name: 'strafing left (-X)',
    shooterFeetPos: new Vec3(0, 0, 0),
    targetStart: new Vec3(20, 0, 5),
    targetHeight: 1.8,
    setup: (e) => {
      e.moveStrafe = -1
    },
    ticksToSimulate: 40,
    weapon: 'bow',
  },
  {
    name: 'diagonal sprint',
    shooterFeetPos: new Vec3(0, 0, 0),
    targetStart: new Vec3(18, 0, -10),
    targetHeight: 1.8,
    setup: (e) => {
      e.moveForward = 1
      e.moveStrafe = 1
      e.isSprinting = true
    },
    ticksToSimulate: 40,
    weapon: 'bow',
  },
  {
    name: 'jumping forward',
    shooterFeetPos: new Vec3(0, 0, 0),
    targetStart: new Vec3(15, 0, 0),
    targetHeight: 1.8,
    setup: (e) => {
      e.moveForward = 1
      e.isJumping = true
    },
    ticksToSimulate: 40,
    weapon: 'bow',
  },
  {
    name: 'sprint jumping',
    shooterFeetPos: new Vec3(0, 0, 0),
    targetStart: new Vec3(18, 0, 0),
    targetHeight: 1.8,
    setup: (e) => {
      e.moveForward = 1
      e.isSprinting = true
      e.isJumping = true
    },
    ticksToSimulate: 40,
    weapon: 'bow',
  },
  {
    name: 'very close 5m stationary',
    shooterFeetPos: new Vec3(0, 0, 0),
    targetStart: new Vec3(5, 0, 0),
    targetHeight: 1.8,
    setup: () => {},
    ticksToSimulate: 40,
    weapon: 'bow',
  },
  {
    name: 'far 50m stationary',
    shooterFeetPos: new Vec3(0, 0, 0),
    targetStart: new Vec3(50, 0, 0),
    targetHeight: 1.8,
    setup: () => {},
    ticksToSimulate: 40,
    weapon: 'bow',
  },
  {
    name: 'far 50m sprinting',
    shooterFeetPos: new Vec3(0, 0, 0),
    targetStart: new Vec3(50, 0, 0),
    targetHeight: 1.8,
    setup: (e) => {
      e.moveForward = 1
      e.isSprinting = true
    },
    ticksToSimulate: 40,
    weapon: 'bow',
  },
  {
    name: 'elevated target +8 walking',
    shooterFeetPos: new Vec3(0, 0, 0),
    targetStart: new Vec3(15, 8, 0),
    targetHeight: 1.8,
    setup: (e) => {
      e.moveForward = 1
    },
    ticksToSimulate: 40,
    weapon: 'bow',
  },
]

async function runTests() {
  const config: BowConfig = { bridgeKnockbackEnabled: false }
  const bowAiming = new BowAiming(config)
  const bot = new MockBot()
  let passed = 0,
    failed = 0
  console.log('Running final bow aiming tests (threshold = 0.2 blocks)\n')

  for (const tc of tests) {
    bowAiming.reset()
    bot.entity.position = tc.shooterFeetPos.clone()
    const target = new MockEntity(1, tc.targetStart, tc.targetHeight)
    tc.setup(target)

    for (let i = 0; i < tc.ticksToSimulate; i++) {
      target.tick()
      bowAiming.compute(bot as unknown as Bot, target as unknown as Entity, tc.weapon)
    }

    const aim = bowAiming.compute(bot as unknown as Bot, target as unknown as Entity, tc.weapon)
    if (!aim) {
      console.log(`❌ ${tc.name.padEnd(35)} No solution`)
      failed++
      continue
    }

    // Arrow origin: bot eye position (feet + 1.62)
    const arrowOrigin = tc.shooterFeetPos.offset(0, 1.62, 0)
    const arrow = simulateArrow(arrowOrigin, aim.yaw, aim.pitch, tc.weapon, 200)
    const targetPath = simulatePlayer(target.position, target.velocity, arrow.length)
    let minDist = Infinity,
      bestTick = 0
    for (let i = 0; i < arrow.length; i++) {
      const arrowPos = arrow[i]!.pos
      const targetFeet = targetPath[i]!
      const targetCenter = targetFeet.offset(0, tc.targetHeight * 0.5, 0)
      const dist = arrowPos.distanceTo(targetCenter)
      if (dist < minDist) {
        minDist = dist
        bestTick = i + 1
      }
    }

    const pass = minDist <= 0.2
    console.log(
      `${pass ? '✅' : '❌'} ${tc.name.padEnd(35)} miss=${minDist.toFixed(4)} @ tick ${bestTick}`,
    )
    if (pass) passed++
    else failed++
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

runTests().catch(console.error)
