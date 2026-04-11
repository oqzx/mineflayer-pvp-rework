import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import type { BowConfig } from '../../config/types.js'
import { solveAimIterative } from '../trajectory.js'
import type { SolvedAim } from '../trajectory.js'

export type AimResult = SolvedAim & {
  weaponName: string
  knockbackDir?: Vec3
}

type PositionSample = { pos: Vec3; tick: number }

class TargetPredictor {
  private readonly history: PositionSample[] = []
  private readonly maxSamples = 8

  record(pos: Vec3, tick: number): void {
    const last = this.history[this.history.length - 1]
    if (last && last.tick === tick) {
      last.pos = pos.clone()
      return
    }
    this.history.push({ pos: pos.clone(), tick })
    if (this.history.length > this.maxSamples) this.history.shift()
  }

  getKinematics(): { velocity: Vec3; acceleration: Vec3 } {
    const zero = new Vec3(0, 0, 0)
    if (this.history.length < 2) return { velocity: zero, acceleration: zero }

    const velocities: Vec3[] = []
    for (let i = this.history.length - 1; i >= 1; i--) {
      const cur = this.history[i]!
      const prev = this.history[i - 1]!
      const dt = cur.tick - prev.tick
      if (dt <= 0) continue
      velocities.push(cur.pos.minus(prev.pos).scaled(1 / dt))
    }

    if (velocities.length === 0) return { velocity: zero, acceleration: zero }

    let totalWeight = 0
    const smoothedVel = new Vec3(0, 0, 0)
    for (let i = 0; i < velocities.length; i++) {
      const w = Math.pow(2, i)
      const v = velocities[i]!
      smoothedVel.x += v.x * w
      smoothedVel.y += v.y * w
      smoothedVel.z += v.z * w
      totalWeight += w
    }
    smoothedVel.x /= totalWeight
    smoothedVel.y /= totalWeight
    smoothedVel.z /= totalWeight

    let acceleration = zero
    if (velocities.length >= 2) {
      const dv = velocities[0]!.minus(velocities[1]!)
      const accMag = Math.sqrt(dv.x * dv.x + dv.y * dv.y + dv.z * dv.z)
      const maxAcc = 0.08
      if (accMag > maxAcc) {
        acceleration = dv.scaled(maxAcc / accMag)
      } else {
        acceleration = dv
      }
    }

    return { velocity: smoothedVel, acceleration }
  }

  predictPosition(currentPos: Vec3, flightTicks: number): Vec3 {
    const { velocity: vel, acceleration: acc } = this.getKinematics()
    const t = Math.min(flightTicks, 25)

    const kinematic = currentPos.offset(
      vel.x * t + 0.5 * acc.x * t * t,
      vel.y * t + 0.5 * acc.y * t * t,
      vel.z * t + 0.5 * acc.z * t * t,
    )

    if (this.history.length < 4) {
      const linear = currentPos.offset(vel.x * t, vel.y * t, vel.z * t)
      const blend = (this.history.length - 2) / 2
      return new Vec3(
        linear.x + (kinematic.x - linear.x) * blend,
        linear.y + (kinematic.y - linear.y) * blend,
        linear.z + (kinematic.z - linear.z) * blend,
      )
    }

    return kinematic
  }

  reset(): void {
    this.history.length = 0
  }
}

function getEntityVelocity(bot: Bot, entity: Entity): Vec3 {
  const trackerVel = (
    (
      bot as unknown as { tracker?: { getEntitySpeed(e: Entity): Vec3 | null } }
    ).tracker?.getEntitySpeed(entity) ?? new Vec3(0, 0, 0)
  )
  // Tracker velocity is at entity-update frequency (~5 Hz), normalize to game-tick frequency (20 Hz)
  // by dividing by 4 to get velocity per game tick
  return trackerVel.scaled(0.25)
}

function detectBridgeOrEdge(bot: Bot, target: Entity): Vec3 | null {
  const targetPos = target.position
  const directions = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

  for (const dir of directions) {
    const checkPos = targetPos.plus(dir.scaled(1.5))
    let hasGround = false
    for (let dy = -1; dy >= -4; dy--) {
      const block = bot.blockAt(checkPos.offset(0, dy, 0))
      if (block && block.name !== 'air') {
        hasGround = true
        break
      }
    }
    if (!hasGround) return dir
  }

  const below = bot.blockAt(targetPos.offset(0, -1, 0))
  if (!below || below.name === 'air') {
    let dropDepth = 0
    for (let dy = -1; dy >= -10; dy--) {
      const b = bot.blockAt(targetPos.offset(0, dy, 0))
      if (b && b.name !== 'air') break
      dropDepth++
    }
    if (dropDepth >= 3) {
      const toBot = bot.entity.position.minus(targetPos)
      return new Vec3(-toBot.x, 0, -toBot.z).normalize()
    }
  }

  return null
}

export function computeKnockbackAim(
  bot: Bot,
  target: Entity,
  edgeDir: Vec3,
  weaponName: string,
): SolvedAim | null {
  const offsetTarget = target.position.plus(edgeDir.scaled(0.8))
  const vel = getEntityVelocity(bot, target)
  const eyePos = bot.entity.position.offset(0, bot.entity.height * 0.9, 0)

  return solveAimIterative(
    eyePos,
    { position: offsetTarget, velocity: vel, height: target.height },
    weaponName,
    8,
  )
}

export class BowAiming {
  private readonly predictor = new TargetPredictor()
  private tick = 0
  private lastTargetId: number | null = null

  constructor(private readonly config: BowConfig) {}

  compute(bot: Bot, target: Entity, weaponName: string): AimResult | null {
    this.tick++

    if (this.lastTargetId !== target.id) {
      this.predictor.reset()
      this.lastTargetId = target.id
    }

    this.predictor.record(target.position.clone(), this.tick)

    const eyePos = bot.entity.position.offset(0, bot.entity.height * 0.9, 0)

    const trackerVel = getEntityVelocity(bot, target)
    const { velocity: histVel, acceleration } = this.predictor.getKinematics()

    const hasTrackerVel = trackerVel.x !== 0 || trackerVel.y !== 0 || trackerVel.z !== 0
    const vel = hasTrackerVel
      ? new Vec3(
          trackerVel.x * 0.4 + histVel.x * 0.6,
          trackerVel.y * 0.4 + histVel.y * 0.6,
          trackerVel.z * 0.4 + histVel.z * 0.6,
        )
      : histVel

    if (this.config.bridgeKnockbackEnabled) {
      const edgeDir = detectBridgeOrEdge(bot, target)
      if (edgeDir) {
        const knockbackAim = computeKnockbackAim(bot, target, edgeDir, weaponName)
        if (knockbackAim) {
          return { ...knockbackAim, weaponName, knockbackDir: edgeDir }
        }
      }
    }

    const aim = solveAimIterative(
      eyePos,
      {
        position: target.position,
        velocity: vel,
        height: target.height,
        acceleration,
      },
      weaponName,
      this.config.leadIterations,
    )

    return aim ? { ...aim, weaponName } : null
  }

  reset(): void {
    this.predictor.reset()
    this.lastTargetId = null
  }
}
