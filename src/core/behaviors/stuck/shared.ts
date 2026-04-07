import { StateBehavior, type StateMachineData } from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import type { Block } from 'prismarine-block'
import { Vec3 } from 'vec3'
import type { PvpData } from '../../pvp-data.js'

export type TrapKind = 'lava' | 'cobweb'

const LAVA_BLOCKS = new Set(['lava', 'flowing_lava'])
const COBWEB_BLOCKS = new Set(['cobweb', 'web'])
const WATER_BLOCKS = new Set(['water', 'flowing_water'])
const EYE_OFFSETS = [1.1]
const FOOT_OFFSETS = [0, -0.2]
export const WATER_SETTLE_TICKS = 4

export function dataOf(state: { data: StateMachineData }): PvpData {
  return state.data as PvpData
}

export function getBlockAt(bot: Bot, pos: Vec3): Block | null {
  return bot.blockAt(pos) ?? null
}

function getBlocksAtOffsets(bot: Bot, offsets: number[]): Block[] {
  const base = bot.entity.position.floored()
  return offsets
    .map((offset) => getBlockAt(bot, base.offset(0, offset, 0)))
    .filter((block): block is Block => block !== null)
}

export function getFaceCobweb(bot: Bot): Block | undefined {
  return getBlocksAtOffsets(bot, EYE_OFFSETS).find((block) => COBWEB_BLOCKS.has(block.name))
}

export function getFloorTrap(bot: Bot): Block | undefined {
  return getBlocksAtOffsets(bot, FOOT_OFFSETS).find((block) => {
    return COBWEB_BLOCKS.has(block.name) || LAVA_BLOCKS.has(block.name)
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
    .find((block): block is Block => block !== null && WATER_BLOCKS.has(block.name))
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
  bot.updateHeldItem()
  console.log('using item', bot.heldItem, 'at', target)
  await bot.lookAt(target, true)
  bot.activateItem(false)
  // await bot.waitForTicks(1)
  // bot.deactivateItem()
}

function getAdjacentOpenPlacementTarget(bot: Bot, trapBlock: Block): Vec3 | undefined {
  const adjacentOffsets = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ]

  for (const offset of adjacentOffsets) {
    const adjacentPos = trapBlock.position.plus(offset)
    const adjacentBlock = getBlockAt(bot, adjacentPos)
    if (adjacentBlock?.boundingBox != "empty") continue
    return adjacentPos
  }

  return undefined
}

export async function placeWaterNextToTrap(bot: Bot, trapBlock: Block): Promise<boolean> {
  const waterBucket = getWaterBucket(bot)
  if (!waterBucket) return false

  const placementTarget = getAdjacentOpenPlacementTarget(bot, trapBlock)
  if (!placementTarget) return false

  const equipped = await equipHand(bot, waterBucket)
  if (!equipped) return false

  await useHeldItemAt(bot, placementTarget.offset(0.5, 0.5, 0.5))
  return true
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

export async function collectPlacedWater(bot: Bot): Promise<boolean> {
  const emptyBucket = getEmptyBucket(bot)
  if (!emptyBucket) return false

  const waterBlock = getNearbyWaterBlock(bot)
  if (!waterBlock) return false

  const equipped = await equipHand(bot, emptyBucket)
  if (!equipped) return false

  await useHeldItemAt(bot, waterBlock.position.offset(0.5, 0.5, 0.5))
  return true
}

export async function breakFaceCobweb(bot: Bot, cobweb: Block): Promise<boolean> {
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

export function shouldCollectPlacedWater(state: { data: StateMachineData }): boolean {
  const data = dataOf(state)
  if (!data.stuckWaterPlaced) return false
  if (data.stuckWaterPlacedTick === undefined) return false
  return data.tick - data.stuckWaterPlacedTick >= WATER_SETTLE_TICKS
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

export function shouldUseWaterForLava(bot: Bot): boolean {
  if (getTrapKind(bot) !== 'lava') return false
  return getWaterBucket(bot) !== undefined
}

export function shouldUseEmptyBucketForLava(bot: Bot): boolean {
  if (getTrapKind(bot) !== 'lava') return false
  return getEmptyBucket(bot) !== undefined
}

export function shouldStayInStuck(state: { bot: Bot; data: StateMachineData }): boolean {
  const data = dataOf(state)
  return isStuck(state.bot) || data.stuckWaterPlaced
}

export function hasPlacedWater(state: { data: StateMachineData }): boolean {
  return dataOf(state).stuckWaterPlaced
}

export function enterStuckState(data: PvpData): void {
  data.sword.stop()
  data.projectile.stop()
  data.stuckWaterPlaced = false
  data.stuckWaterPlacedTick = undefined
  data.sword.bot.clearControlStates()
}

export function exitStuckState(data: PvpData): void {
  data.stuckWaterPlaced = false
  data.stuckWaterPlacedTick = undefined
  data.sword.bot.clearControlStates()
}

export abstract class StuckActionBehavior extends StateBehavior {
  private finished = false

  onStateEntered(): void {
    void this.runAction().finally(() => {
      this.finished = true
    })
  }

  update(): void {}

  isFinished(): boolean {
    return this.finished
  }

  onStateExited(): void {}

  protected abstract runAction(): Promise<void>
}
