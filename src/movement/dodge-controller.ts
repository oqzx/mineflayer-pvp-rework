import type { Bot, ControlState } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import type { DodgeConfig } from '../config/types.js'
import type { AimingEntity, IncomingProjectile } from '../core/combat-state.js'
import { vectorMagnitude, clamp } from '../calc/math.js'
import { MS_PER_TICK } from '../calc/constants.js'
import { delay } from '../util/humanizer.js'

const FIREBALL_ENTITY_NAMES = ['fireball', 'small_fireball', 'wither_skull']
const ARROW_ENTITY_NAMES = ['arrow', 'spectral_arrow', 'trident']

const PLAYER_HALF_WIDTH = 0.3
const PLAYER_HEIGHT = 1.8
const ARROW_GRAVITY = 0.05
const ARROW_DRAG = 0.99
const MAX_SIMULATE_TICKS = 80
const DANGER_ZONE_PADDING = 0.3 * 5

export function classifyProjectile(entity: Entity): IncomingProjectile['type'] | null {
  const name = entity.name?.toLowerCase() ?? ''
  if (ARROW_ENTITY_NAMES.some((p) => name.includes(p))) return 'arrow'
  if (FIREBALL_ENTITY_NAMES.some((p) => name.includes(p))) return 'fireball'
  if (name === 'ender_pearl') return 'pearl'
  return null
}

interface ArrowFrame {
  pos: Vec3
  vel: Vec3
}

function stepArrow(frame: ArrowFrame): ArrowFrame {
  const vel = new Vec3(
    frame.vel.x * ARROW_DRAG,
    frame.vel.y * ARROW_DRAG - ARROW_GRAVITY,
    frame.vel.z * ARROW_DRAG,
  )
  return { pos: frame.pos.plus(vel), vel }
}

function botAABB(pos: Vec3): {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
} {
  return {
    minX: pos.x - PLAYER_HALF_WIDTH,
    maxX: pos.x + PLAYER_HALF_WIDTH,
    minY: pos.y,
    maxY: pos.y + PLAYER_HEIGHT,
    minZ: pos.z - PLAYER_HALF_WIDTH,
    maxZ: pos.z + PLAYER_HALF_WIDTH,
  }
}

function segmentIntersectsAABB(from: Vec3, to: Vec3, aabb: ReturnType<typeof botAABB>): boolean {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z

  let tMin = 0
  let tMax = 1

  for (const [origin, delta, boxMin, boxMax] of [
    [from.x, dx, aabb.minX, aabb.maxX],
    [from.y, dy, aabb.minY, aabb.maxY],
    [from.z, dz, aabb.minZ, aabb.maxZ],
  ] as [number, number, number, number][]) {
    if (Math.abs(delta) < 1e-9) {
      if (origin < boxMin || origin > boxMax) return false
    } else {
      const t1 = (boxMin - origin) / delta
      const t2 = (boxMax - origin) / delta
      tMin = Math.max(tMin, Math.min(t1, t2))
      tMax = Math.min(tMax, Math.max(t1, t2))
      if (tMin > tMax) return false
    }
  }
  return true
}

interface ImpactInfo {
  tick: number
  arrowPosAtImpact: Vec3
  arrowVelAtImpact: Vec3
  prevArrowPos: Vec3
}

function simulateArrowImpact(
  arrowPos: Vec3,
  arrowVel: Vec3,
  botPos: Vec3,
  expandAABB: number,
): ImpactInfo | null {
  const expandedAABB = {
    minX: botPos.x - PLAYER_HALF_WIDTH - expandAABB,
    maxX: botPos.x + PLAYER_HALF_WIDTH + expandAABB,
    minY: botPos.y - expandAABB,
    maxY: botPos.y + PLAYER_HEIGHT + expandAABB,
    minZ: botPos.z - PLAYER_HALF_WIDTH - expandAABB,
    maxZ: botPos.z + PLAYER_HALF_WIDTH + expandAABB,
  }

  let frame: ArrowFrame = { pos: arrowPos.clone(), vel: arrowVel.clone() }

  for (let t = 0; t < MAX_SIMULATE_TICKS; t++) {
    const prev = frame.pos.clone()
    frame = stepArrow(frame)

    if (segmentIntersectsAABB(prev, frame.pos, expandedAABB)) {
      return {
        tick: t,
        arrowPosAtImpact: frame.pos,
        arrowVelAtImpact: frame.vel,
        prevArrowPos: prev,
      }
    }

    if (frame.pos.y < botPos.y - 5) break
  }
  return null
}

function nearestPointOnLine2D(lineOrigin: Vec3, lineDir: Vec3, point: Vec3): Vec3 {
  const t =
    ((point.x - lineOrigin.x) * lineDir.x + (point.z - lineOrigin.z) * lineDir.z) /
    (lineDir.x * lineDir.x + lineDir.z * lineDir.z + 1e-9)
  return new Vec3(lineOrigin.x + t * lineDir.x, 0, lineOrigin.z + t * lineDir.z)
}

function canWalkTowards(bot: Bot, from: Vec3, towards: Vec3, checkDist: number): boolean {
  const dir = towards.minus(from)
  const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z)
  if (len < 1e-6) return true
  const norm = new Vec3(dir.x / len, 0, dir.z / len)
  const checkTo = from.offset(norm.x * checkDist, 0, norm.z * checkDist)

  const world = (
    bot as unknown as {
      world: { raycast: (from: Vec3, direction: Vec3, range: number) => { position: Vec3 } | null }
    }
  ).world
  if (!world?.raycast) return true

  for (const yOffset of [0.6, 1.6]) {
    const rayFrom = from.offset(0, yOffset, 0)
    const rayTo = checkTo.offset(0, yOffset, 0)
    const rayDir = rayTo.minus(rayFrom).normalize()
    const hit = world.raycast(rayFrom, rayDir, checkDist + 0.1)
    if (hit) {
      const hitDist = rayFrom.distanceTo(hit.position)
      if (hitDist < checkDist) return false
    }
  }
  return true
}

interface DodgeSolution {
  dodgeDir: ControlState | null
  shouldJump: boolean
  dodgeTickDuration: number
  urgency: number
}

function planArrowDodge(bot: Bot, impact: ImpactInfo, config: DodgeConfig): DodgeSolution {
  const botPos = bot.entity.position
  const vel2d = new Vec3(impact.arrowVelAtImpact.x, 0, impact.arrowVelAtImpact.z)
  const speed2d = vectorMagnitude(vel2d)

  const rightPerp =
    speed2d > 0.01 ? new Vec3(vel2d.z / speed2d, 0, -vel2d.x / speed2d) : new Vec3(1, 0, 0)

  const lineOrigin = new Vec3(impact.prevArrowPos.x, 0, impact.prevArrowPos.z)
  const lineDir =
    speed2d > 0.01 ? new Vec3(vel2d.x / speed2d, 0, vel2d.z / speed2d) : new Vec3(1, 0, 0)

  const nearest = nearestPointOnLine2D(lineOrigin, lineDir, new Vec3(botPos.x, 0, botPos.z))
  const toBot = new Vec3(botPos.x - nearest.x, 0, botPos.z - nearest.z)
  const dot = toBot.x * rightPerp.x + toBot.z * rightPerp.z

  const safeRight = nearest.offset(
    rightPerp.x * DANGER_ZONE_PADDING,
    0,
    rightPerp.z * DANGER_ZONE_PADDING,
  )
  const safeLeft = nearest.offset(
    -rightPerp.x * DANGER_ZONE_PADDING,
    0,
    -rightPerp.z * DANGER_ZONE_PADDING,
  )

  const botVel2d = new Vec3(bot.entity.velocity.x, 0, bot.entity.velocity.z)
  const momentumRight = botVel2d.x * rightPerp.x + botVel2d.z * rightPerp.z

  let preferRight = dot >= 0

  const rightBlocked = !canWalkTowards(bot, botPos, safeRight, DANGER_ZONE_PADDING)
  const leftBlocked = !canWalkTowards(bot, botPos, safeLeft, DANGER_ZONE_PADDING)

  if (rightBlocked && !leftBlocked) preferRight = false
  else if (leftBlocked && !rightBlocked) preferRight = true
  else if (Math.abs(momentumRight) > 0.04) preferRight = momentumRight > 0

  const targetSafe = preferRight ? safeRight : safeLeft
  const distToSafe = botPos.distanceTo(targetSafe)

  const ticksAvailable = impact.tick
  const sprintSpeed = 0.13
  const walkSpeed = 0.1
  const effectiveSpeed = bot.entity.onGround ? sprintSpeed : walkSpeed
  const ticksNeeded = distToSafe / effectiveSpeed

  const urgency = clamp(ticksNeeded / Math.max(1, ticksAvailable), 0, 1)

  const heightAtImpact = impact.arrowPosAtImpact.y - botPos.y
  const jumpClears =
    heightAtImpact < 0.5 && heightAtImpact > -0.3 && bot.entity.onGround && config.jumpEnabled
  const shouldJump = jumpClears && urgency > 0.6

  const dodgeTickDuration = Math.max(4, Math.min(12, Math.ceil(ticksNeeded * 1.2)))

  return {
    dodgeDir: preferRight ? 'right' : 'left',
    shouldJump,
    dodgeTickDuration,
    urgency,
  }
}

export function estimateImpactTick(projectile: Entity, target: Entity): number {
  const impact = simulateArrowImpact(
    projectile.position,
    projectile.velocity,
    target.position,
    DANGER_ZONE_PADDING,
  )
  return impact?.tick ?? 999
}

export function chooseDodgeDir(projectile: Entity, bot: Entity): ControlState {
  const vel = projectile.velocity
  const speed = vectorMagnitude(vel)
  if (speed < 0.01) return 'left'
  const dir = new Vec3(vel.x / speed, 0, vel.z / speed)
  const rightPerp = new Vec3(dir.z, 0, -dir.x)
  const toBot = bot.position.minus(projectile.position)
  const dot = toBot.x * rightPerp.x + toBot.z * rightPerp.z
  return dot >= 0 ? 'right' : 'left'
}

export class DodgeController {
  private dodging = false
  private deflecting = false

  constructor(private readonly config: DodgeConfig) {}

  async handleIncoming(bot: Bot, threat: IncomingProjectile | AimingEntity): Promise<void> {
    if (!this.config.enabled || this.dodging) return

    if (threat.type === 'fireball') {
      const dist = bot.entity.position.distanceTo(threat.entity.position)
      if (dist <= 4.5) {
        await this.deflectFireball(bot, threat.entity)
        return
      }
    }

    await this.dodgeProjectile(bot, threat)
  }

  private async dodgeProjectile(
    bot: Bot,
    threat: IncomingProjectile | AimingEntity,
  ): Promise<void> {
    const projectile = threat.entity

    const impact = simulateArrowImpact(
      projectile.position,
      projectile.velocity,
      bot.entity.position,
      DANGER_ZONE_PADDING,
    )

    if (!impact) return

    const distToLine = this.distToArrowLine2D(projectile, bot.entity)
    if (distToLine > DANGER_ZONE_PADDING) return

    const solution = planArrowDodge(bot, impact, this.config)
    if (!solution.dodgeDir) return

    const reactionMs =
      this.config.reactionDelayMs.min +
      Math.random() * (this.config.reactionDelayMs.max - this.config.reactionDelayMs.min)

    if (reactionMs > 0 && impact.tick > 2) {
      await delay(reactionMs)
    }

    if (!bot.entity) return

    const reImpact = simulateArrowImpact(
      projectile.position,
      projectile.velocity,
      bot.entity.position,
      DANGER_ZONE_PADDING,
    )
    if (!reImpact) return

    this.dodging = true

    try {
      const finalSolution = planArrowDodge(bot, reImpact, this.config)
      if (!finalSolution.dodgeDir) return

      const opposite: ControlState = finalSolution.dodgeDir === 'left' ? 'right' : 'left'

      if (finalSolution.shouldJump && bot.entity.onGround) {
        bot.setControlState('jump', true)
        await delay(MS_PER_TICK)
        bot.setControlState('jump', false)
      }

      bot.setControlState(finalSolution.dodgeDir, true)
      bot.setControlState(opposite, false)

      await delay(finalSolution.dodgeTickDuration * MS_PER_TICK)

      bot.setControlState(finalSolution.dodgeDir, false)
    } finally {
      this.dodging = false
    }
  }

  private distToArrowLine2D(projectile: Entity, botEntity: Entity): number {
    const vel2d = new Vec3(projectile.velocity.x, 0, projectile.velocity.z)
    const speed2d = vectorMagnitude(vel2d)
    if (speed2d < 0.01) return 0

    const dir = new Vec3(vel2d.x / speed2d, 0, vel2d.z / speed2d)
    const origin = new Vec3(projectile.position.x, 0, projectile.position.z)
    const botPos2d = new Vec3(botEntity.position.x, 0, botEntity.position.z)

    const nearest = nearestPointOnLine2D(origin, dir, botPos2d)
    return nearest.distanceTo(botPos2d)
  }

  private async deflectFireball(bot: Bot, fireball: Entity): Promise<void> {
    if (this.deflecting) return
    this.deflecting = true

    try {
      const center = fireball.position.offset(0, fireball.height / 2, 0)
      await bot.lookAt(center, true)

      for (let i = 0; i < 6; i++) {
        bot.attack(fireball)
        await delay(
          this.config.deflectIntervalMs.min +
            Math.random() * (this.config.deflectIntervalMs.max - this.config.deflectIntervalMs.min),
        )
      }
    } finally {
      this.deflecting = false
    }
  }
}
