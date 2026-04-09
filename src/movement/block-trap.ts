import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import type { BlockTrapConfig } from '../config/types.js'
import { randomIntInRange, shouldTrigger } from '../util/humanizer.js'

const PI = Math.PI
const TWO_PI = PI * 2

const PLACEABLE_NAMES: ReadonlySet<string> = new Set([
  'cobblestone',
  'stone',
  'granite',
  'diorite',
  'andesite',
  'dirt',
  'gravel',
  'sand',
  'sandstone',
  'red_sandstone',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'crimson_planks',
  'warped_planks',
  'netherrack',
  'end_stone',
  'nether_brick',
  'quartz_block',
  'purpur_block',
  'terracotta',
  'white_terracotta',
  'orange_terracotta',
  'concrete',
  'white_concrete',
  'gray_concrete',
])

const CANDIDATE_FACES: ReadonlyArray<{ neighborOffset: Vec3; face: Vec3 }> = [
  { neighborOffset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
  { neighborOffset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
  { neighborOffset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
  { neighborOffset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
  { neighborOffset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
  { neighborOffset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) },
]

const MAX_REACH_SQ = 4.5 * 4.5

export class BlockTrap {
  private active = false
  private cooldownLeft = 0

  constructor(private readonly config: BlockTrapConfig) {}

  tick(): void {
    if (this.cooldownLeft > 0) this.cooldownLeft--
  }

  get isActive(): boolean {
    return this.active
  }

  computeScore(bot: Bot, target: Entity, ticksSinceLastHurt: number, botHealth: number): number {
    if (this.findBlockItem(bot) === null) return 0

    const dx = bot.entity.position.x - target.position.x
    const dz = bot.entity.position.z - target.position.z
    const distSq = dx * dx + dz * dz

    if (distSq > this.config.triggerRange * this.config.triggerRange) return 0

    let score = this.config.baseScore

    if (ticksSinceLastHurt <= this.config.comboEscapeTickWindow) {
      score += this.config.comboEscapeScoreBonus
    }

    const targetSpeed = Math.hypot(target.velocity.x, target.velocity.z)
    score +=
      Math.min(targetSpeed / this.config.velocityNormFactor, 1.0) * this.config.velocityScoreWeight

    const healthFraction = Math.max(0, botHealth - this.config.healthPressureThreshold) / 20
    score += (1 - healthFraction) * this.config.healthPressureWeight

    const distNorm = Math.sqrt(distSq) / this.config.triggerRange
    score += (1 - distNorm) * this.config.proximityScoreWeight

    return score
  }

  shouldAttempt(bot: Bot, target: Entity, ticksSinceLastHurt: number, botHealth: number): boolean {
    if (!this.config.enabled || this.active || this.cooldownLeft > 0) return false
    return (
      this.computeScore(bot, target, ticksSinceLastHurt, botHealth) >= this.config.minTriggerScore
    )
  }

  async execute(bot: Bot, target: Entity, reequipFn: () => Promise<void>): Promise<void> {
    if (this.active) return
    this.active = true
    try {
      await this.runTrap(bot, target, reequipFn)
    } finally {
      this.active = false
      this.cooldownLeft = this.config.cooldownTicks
    }
  }

  private async runTrap(bot: Bot, target: Entity, reequipFn: () => Promise<void>): Promise<void> {
    const blockItem = this.findBlockItem(bot)
    if (!blockItem) return

    const equipped = await (
      bot.util.inv as { customEquip: (item: Item, dest: string) => Promise<boolean> }
    ).customEquip(blockItem, 'hand')
    if (!equipped) return

    const ep = target.position
    const vel = target.velocity
    const centerX = Math.floor(ep.x)
    const centerZ = Math.floor(ep.z)
    const floorY = Math.floor(ep.y) - 1
    const speed = Math.hypot(vel.x, vel.z)

    const trapPositions: Vec3[] = [new Vec3(centerX, floorY, centerZ)]

    if (this.config.twoBlockEnabled && speed > this.config.twoBlockVelocityThreshold) {
      if (Math.abs(vel.x) >= Math.abs(vel.z)) {
        trapPositions.unshift(new Vec3(centerX + Math.sign(vel.x), floorY, centerZ))
      } else {
        trapPositions.unshift(new Vec3(centerX, floorY, centerZ + Math.sign(vel.z)))
      }
    }

    let anyPlaced = false
    for (const pos of trapPositions) {
      const placed = await this.placeAt(bot, pos)
      if (placed) {
        anyPlaced = true
        const jitter = randomIntInRange(this.config.placementJitterTicks)
        if (jitter > 0) await bot.waitForTicks(jitter)
      }
    }

    if (!anyPlaced) return

    const doPillar =
      this.config.pillarEnabled &&
      this.findBlockItem(bot) !== null &&
      shouldTrigger(
        speed > 0.05
          ? this.config.pillarMovingProbability
          : this.config.pillarStationaryProbability,
      )

    if (doPillar) {
      await bot.waitForTicks(1)
      bot.setControlState('jump', true)
      await bot.waitForTicks(1)
      await this.placeAt(bot, new Vec3(centerX, Math.floor(ep.y) + 1, centerZ))
      bot.setControlState('jump', false)
    }

    this.applySidestep(bot, target)
    await reequipFn()
  }

  private async placeAt(bot: Bot, targetPos: Vec3): Promise<boolean> {
    const occupying = bot.blockAt(targetPos)
    if (occupying && occupying.boundingBox !== 'empty') return false

    const eyePos = bot.entity.position.offset(0, bot.entity.height * 0.9, 0)

    for (const { neighborOffset, face } of CANDIDATE_FACES) {
      const neighborPos = targetPos.plus(neighborOffset)
      const neighbor = bot.blockAt(neighborPos)
      if (!neighbor || neighbor.boundingBox === 'empty') continue

      const faceCenter = neighborPos.offset(0.5, 0.5, 0.5).plus(face.scaled(0.5))

      const dx = faceCenter.x - eyePos.x
      const dy = faceCenter.y - eyePos.y
      const dz = faceCenter.z - eyePos.z
      if (dx * dx + dy * dy + dz * dz > MAX_REACH_SQ) continue

      await bot.lookAt(faceCenter, true)
      await bot.waitForTicks(1)

      try {
        await bot.placeBlock(neighbor, face)
        return true
      } catch {
        continue
      }
    }

    return false
  }

  private applySidestep(bot: Bot, target: Entity): void {
    const dir = this.chooseSideDir(bot, target)
    bot.setControlState(dir === 'left' ? 'right' : 'left', false)
    bot.setControlState(dir, true)
  }

  private chooseSideDir(bot: Bot, target: Entity): 'left' | 'right' {
    const bp = bot.entity.position
    const ep = target.position
    const angleToBot = Math.atan2(bp.z - ep.z, bp.x - ep.x)
    const rel = ((angleToBot - target.yaw + PI * 3) % TWO_PI) - PI
    return rel >= 0 ? 'left' : 'right'
  }

  private findBlockItem(bot: Bot): Item | null {
    return (
      bot.inventory
        .items()
        .find((item) => PLACEABLE_NAMES.has(item.name) || item.name.endsWith('_planks')) ?? null
    )
  }
}
