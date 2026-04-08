import { StateBehavior, type StateMachineData } from '@nxg-org/mineflayer-static-statemachine'
import { AABBUtils } from '@nxg-org/mineflayer-util-plugin'
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import type { Block } from 'prismarine-block'
import { Vec3 } from 'vec3'
import type { PvpData } from '../../pvp-data.js'

export type TrapKind = 'lava' | 'cobweb'

const LAVA_BLOCKS = new Set(['lava', 'flowing_lava'])
const COBWEB_BLOCKS = new Set(['cobweb', 'web'])
const WATER_BLOCKS = new Set(['water', 'flowing_water'])
export const WATER_SETTLE_TICKS = 4

export function dataOf(state: { data: StateMachineData }): PvpData {
  return state.data as PvpData
}

export function getBlockAt(bot: Bot, pos: Vec3): Block | null {
  return bot.blockAt(pos) ?? null
}

function getBotAABB(bot: Bot) {
  return AABBUtils.getEntityAABB(bot.entity)
}

function getCandidateBlocks(bot: Bot): Block[] {
  const aabb = getBotAABB(bot)
  const minX = Math.floor(aabb.minX)
  const maxX = Math.floor(aabb.maxX)
  const minY = Math.floor(aabb.minY)
  const maxY = Math.floor(aabb.maxY)
  const minZ = Math.floor(aabb.minZ)
  const maxZ = Math.floor(aabb.maxZ)
  const blocks: Block[] = []

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        const block = getBlockAt(bot, new Vec3(x, y, z))
        if (!block) continue
        blocks.push(block)
      }
    }
  }

  return blocks
}

function isTrapBlock(block: Block): boolean {
  return COBWEB_BLOCKS.has(block.name) || LAVA_BLOCKS.has(block.name)
}

export function getIntersectingTrapBlocks(bot: Bot): Block[] {
  const botAabb = getBotAABB(bot)
  return getCandidateBlocks(bot).filter((block) => {
    if (!isTrapBlock(block)) return false
    return botAabb.intersects(AABBUtils.getBlockAABB(block))
  })
}

function isHeadLevelBlock(bot: Bot, block: Block): boolean {
  const botMidY = bot.entity.position.y + bot.entity.height * 0.5
  const blockCenterY = block.position.y + 0.5
  return blockCenterY >= botMidY
}

export function getFaceCobweb(bot: Bot): Block | undefined {
  return getIntersectingTrapBlocks(bot).find((block) => {
    return COBWEB_BLOCKS.has(block.name) && isHeadLevelBlock(bot, block)
  })
}

export function getFloorTrap(bot: Bot): Block | undefined {
  return getIntersectingTrapBlocks(bot).find((block) => {
    return !isHeadLevelBlock(bot, block)
  })
}

export function getTrapBlock(bot: Bot): Block | undefined {
  const faceCobweb = getFaceCobweb(bot)
  if (faceCobweb) return faceCobweb
  return getFloorTrap(bot)
}

export function getTrapKind(bot: Bot): TrapKind | undefined {
  const trapBlock = getTrapBlock(bot)
  if (!trapBlock) return undefined
  if (LAVA_BLOCKS.has(trapBlock.name)) return 'lava'
  if (COBWEB_BLOCKS.has(trapBlock.name)) return 'cobweb'
  return undefined
}

export function isHeadStuck(bot: Bot): boolean {
  return getFaceCobweb(bot) !== undefined
}

export function isFeetStuck(bot: Bot): boolean {
  return getFloorTrap(bot) !== undefined
}

export function getNearbyWaterBlock(bot: Bot): Block | undefined {
  const base = bot.entity.position.floored()
  const eyePos = bot.entity.position.offset(0, 1.62, 0)
  const positions = [
    base,
    base.offset(0, -1, 0),
    base.offset(0, 1, 0),
    base.offset(1, 0, 0),
    base.offset(-1, 0, 0),
    base.offset(0, 0, 1),
    base.offset(0, 0, -1),
  ]

  return positions
    .map((pos) => getBlockAt(bot, pos))
    .find((block): block is Block => {
      if (block === null) return false

      const isFullWaterSource = WATER_BLOCKS.has(block.name) && block.metadata === 0
      const isWaterlogged =
        (block as Block & { _properties?: { waterlogged?: boolean } })._properties?.waterlogged ===
        true
      const inReach = AABBUtils.getBlockAABB(block).distanceToVec(eyePos) < 5

      return (isFullWaterSource || isWaterlogged) && inReach
    })
}

function findItem(bot: Bot, names: string[]): Item | undefined {
  return bot.inventory.items().find((item) => names.includes(item.name))
}

export function getWaterBucket(bot: Bot): Item | undefined {
  return findItem(bot, ['water_bucket'])
}

export function getEmptyBucket(bot: Bot): Item | undefined {
  return findItem(bot, ['bucket'])
}

export function getSword(bot: Bot): Item | undefined {
  return bot.inventory.items().find((item) => item.name.endsWith('_sword') || item.name === 'sword')
}

export async function equipHand(bot: Bot, item: Item): Promise<boolean> {
  return bot.util.inv.customEquip(item, 'hand')
}

async function useHeldItemAt(bot: Bot, target: Vec3): Promise<void> {
  await bot.lookAt(target, true)
  await bot.waitForTicks(1)
  bot.activateItem(false)
}

function getAdjacentOpenPlacementTarget(
  bot: Bot,
  trapBlock: Block,
  failedPlacements: Set<string>,
): Vec3 | undefined {
  const adjacentOffsets = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ]
  const eyePos = bot.entity.position.offset(0, bot.entity.height * 0.9, 0)
  const intersectingTrapKeys = new Set(
    getIntersectingTrapBlocks(bot).map((block) => block.position.toString()),
  )
  for (const offset of adjacentOffsets) {
    const adjacentPos = trapBlock.position.plus(offset)
    if (failedPlacements.has(adjacentPos.toString())) continue
    const adjacentBlock = getBlockAt(bot, adjacentPos)
    if (adjacentBlock?.boundingBox != 'empty') continue
    const targetCenter = adjacentPos.offset(0.5, 0.5, 0.5)
    const dir = targetCenter.minus(eyePos)
    const distance = dir.norm()
    if (distance <= 0) continue

    const hit = bot.world.raycast(eyePos, dir.normalize(), distance)
    if (hit) {
      const hitKey = new Vec3(hit.x, hit.y, hit.z).toString()
      if (intersectingTrapKeys.has(hitKey)) continue
    }
    return adjacentPos
  }

  return undefined
}

export async function placeWaterNextToTrap(
  bot: Bot,
  trapBlock: Block,
  failedPlacements: Set<string>,
): Promise<Vec3 | undefined> {
  const waterBucket = getWaterBucket(bot)
  if (!waterBucket) return undefined

  const placementTarget = getAdjacentOpenPlacementTarget(bot, trapBlock, failedPlacements)
  if (!placementTarget) return undefined

  const equipped = await equipHand(bot, waterBucket)
  if (!equipped) return undefined

  await useHeldItemAt(bot, placementTarget.offset(0.5, 0, 0.5))
  return placementTarget
}

export async function pickUpLavaWithWater(bot: Bot, lavaBlock: Block): Promise<boolean> {
  const waterBucket = getWaterBucket(bot)
  if (!waterBucket) return false

  const equipped = await equipHand(bot, waterBucket)
  if (!equipped) return false

  await useHeldItemAt(bot, lavaBlock.position.offset(0.5, 0.5, 0.5))
  return true
}

export async function pickUpLavaWithEmptyBucket(bot: Bot, lavaBlock: Block): Promise<boolean> {
  const emptyBucket = getEmptyBucket(bot)
  if (!emptyBucket) return false

  const equipped = await equipHand(bot, emptyBucket)
  if (!equipped) return false

  await useHeldItemAt(bot, lavaBlock.position.offset(0.5, 0.5, 0.5))
  return true
}

export async function collectPlacedWater(bot: Bot, placedPos?: Vec3): Promise<boolean> {
  const emptyBucket = getEmptyBucket(bot)
  if (!emptyBucket) return false

  const waterBlock = placedPos ? getBlockAt(bot, placedPos) : getNearbyWaterBlock(bot)
  if (!waterBlock) return false

  const equipped = await equipHand(bot, emptyBucket)
  if (!equipped) return false

  await useHeldItemAt(bot, waterBlock.position.offset(0.5, 1, 0.5))
  return true
}

export async function breakCobweb(bot: Bot, cobweb: Block): Promise<boolean> {
  const sword = getSword(bot)
  if (!sword) return false

  const equipped = await equipHand(bot, sword)
  if (!equipped) return false

  await bot.lookAt(cobweb.position.offset(0.5, 0.5, 0.5), true)
  await bot.dig(cobweb, true)
  return true
}

export function isFinished(state: { isFinished(): boolean }): boolean {
  return state.isFinished()
}

export function isStuck(bot: Bot): boolean {
  return getTrapKind(bot) !== undefined
}

export function shouldUseWaterForCobweb(bot: Bot): boolean {
  if (getTrapKind(bot) !== 'cobweb') return false
  if (getFaceCobweb(bot)) return false
  if (!getFloorTrap(bot)) return false
  return getWaterBucket(bot) !== undefined
}

export function shouldBreakFaceCobweb(bot: Bot): boolean {
  if (getTrapKind(bot) !== 'cobweb') return false
  if (!getFaceCobweb(bot)) return false
  return getSword(bot) !== undefined
}

export function shouldBreakFloorCobweb(bot: Bot): boolean {
  if (getTrapKind(bot) !== 'cobweb') return false
  if (getFaceCobweb(bot)) return false
  if (!getFloorTrap(bot)) return false
  return getSword(bot) !== undefined
}

export function shouldUseWaterForLava(bot: Bot): boolean {
  if (getTrapKind(bot) !== 'lava') return false
  return getWaterBucket(bot) !== undefined
}

export function shouldUseEmptyBucketForLava(bot: Bot): boolean {
  if (getTrapKind(bot) !== 'lava') return false
  return getEmptyBucket(bot) !== undefined
}

export function shouldStayInStuck(state: { bot: Bot; data: StateMachineData }): boolean {
  return isStuck(state.bot)
}

export function enterStuckState(data: PvpData): void {
  data.sword.stop()
  data.projectile.stop()
  data.stuckWaterFailedPlacements.clear()
  data.sword.bot.clearControlStates()
}

export function exitStuckState(data: PvpData): void {
  data.stuckWaterFailedPlacements.clear()
  data.sword.bot.clearControlStates()
}

export abstract class StuckActionState<Args extends unknown[] = []> extends StateBehavior {
  private finished = false

  onStateEntered(...args: Args): void {
    void this.executeEntered(...args)
  }

  update(): void {}

  isFinished(): boolean {
    return this.finished
  }

  onStateExited(): void {}

  private async executeEntered(...args: Args): Promise<void> {
    try {
      await this.performAction(...args)
    } finally {
      this.finished = true
    }
  }

  protected abstract performAction(...args: Args): Promise<void>
}
