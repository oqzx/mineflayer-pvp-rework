import { StateBehavior, getTransition, behaviors, type StateMachineData } from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { holdJumpForNextTick } from '../../../util/jump-control.js'
import {
  StuckActionBehavior,
  breakCobweb,
  collectPlacedWater,
  dataOf,
  getFloorTrap,
  getTrapKind,
  isFinished,
  pickUpLavaWithEmptyBucket,
  pickUpLavaWithWater,
  placeWaterNextToTrap,
  shouldCollectPlacedWater,
  shouldBreakFloorCobweb,
  shouldStayInStuck,
  shouldUseEmptyBucketForLava,
  shouldUseWaterForCobweb,
  shouldUseWaterForLava,
} from './shared.js'

const PLAYER_ESCAPE_RANGE = 6

function getNearestNearbyPlayer(bot: Bot, maxDistance: number): Entity | undefined {
  let nearest: Entity | undefined
  let nearestDistance = maxDistance

  for (const entity of Object.values(bot.entities)) {
    if (entity.type !== 'player') continue
    if (entity.id === bot.entity.id) continue

    const distance = bot.entity.position.distanceTo(entity.position)
    if (distance > nearestDistance) continue

    nearest = entity
    nearestDistance = distance
  }

  return nearest
}

export class StuckFeetAssessBehavior extends StateBehavior {
  static readonly stateName = 'StuckFeetAssess'

  constructor(bot: Bot, data: StateMachineData) {
    super(bot, data)
  }

  onStateEntered(): void {}

  update(): void {}

  isFinished(): boolean {
    return false
  }

  onStateExited(): void {}
}

export class StuckUseWaterBehavior extends StuckActionBehavior {
  static readonly stateName = 'StuckUseWater'

  protected async runAction(): Promise<void> {
    const data = dataOf(this)
    const trapKind = getTrapKind(this.bot)

    if (trapKind === 'cobweb') {
      const floorTrap = getFloorTrap(this.bot)
      if (!floorTrap) return

      const placedPos = await placeWaterNextToTrap(
        this.bot,
        floorTrap,
        data.stuckWaterFailedPlacements,
      )
      if (!placedPos) return

      data.stuckWaterPlaced = true
      data.stuckWaterPlacedTick = data.tick
      data.stuckWaterPlacedPos = placedPos
      return
    }

    if (trapKind === 'lava') {
      const lavaBlock = getFloorTrap(this.bot)
      if (!lavaBlock) return

      const used = await pickUpLavaWithWater(this.bot, lavaBlock)
      if (!used) return

      data.stuckWaterPlaced = true
      data.stuckWaterPlacedTick = data.tick
      data.stuckWaterPlacedPos = lavaBlock.position.clone()
    }
  }
}

export class StuckUseBucketBehavior extends StuckActionBehavior {
  static readonly stateName = 'StuckUseBucket'

  protected async runAction(): Promise<void> {
    const lavaBlock = getFloorTrap(this.bot)
    if (!lavaBlock) return
    await pickUpLavaWithEmptyBucket(this.bot, lavaBlock)
  }
}

export class StuckCollectWaterBehavior extends StuckActionBehavior {
  static readonly stateName = 'StuckCollectWater'

  protected async runAction(): Promise<void> {
    const data = dataOf(this)
    const placedPos = data.stuckWaterPlacedPos
    const collected = await collectPlacedWater(this.bot, data.stuckWaterPlacedPos)
    if (!collected) return

    const trapKind = getTrapKind(this.bot)
    const floorTrap = getFloorTrap(this.bot)
    const cobwebStillAtFeet =
      trapKind === 'cobweb' && floorTrap !== undefined && floorTrap.name.includes('web')

    if (cobwebStillAtFeet && placedPos) {
      data.stuckWaterFailedPlacements.add(placedPos.toString())
    }

    data.stuckWaterPlaced = false
    data.stuckWaterPlacedTick = undefined
    data.stuckWaterPlacedPos = undefined
  }
}

export class StuckBreakFloorCobwebBehavior extends StuckActionBehavior {
  static readonly stateName = 'StuckBreakFloorCobweb'

  protected async runAction(): Promise<void> {
    const floorTrap = getFloorTrap(this.bot)
    if (!floorTrap) return
    await breakCobweb(this.bot, floorTrap)
  }
}

export class StuckFeetMoveEscapeBehavior extends StuckActionBehavior {
  static readonly stateName = 'StuckFeetMoveEscape'

  protected async runAction(): Promise<void> {
    const data = dataOf(this)
    const goLeft = data.tick % 12 < 6
    const dir = goLeft ? 'left' : 'right'
    const opposite = goLeft ? 'right' : 'left'
    const nearestPlayer = getNearestNearbyPlayer(this.bot, PLAYER_ESCAPE_RANGE)
    const shouldBackAway = nearestPlayer !== undefined

    this.bot.setControlState('back', shouldBackAway)
    this.bot.setControlState('sprint', true)
    this.bot.setControlState('forward', !shouldBackAway)
    this.bot.setControlState(dir, true)
    this.bot.setControlState(opposite, false)
    holdJumpForNextTick(this.bot)
    await this.bot.waitForTicks(1)
  }
}

export function buildFeetStuckTransitions(exitState: typeof StateBehavior) {
  return [
    getTransition('feetAssessToExit', StuckFeetAssessBehavior, exitState)
      .setShouldTransition((state) => !shouldStayInStuck(state))
      .build(),

    getTransition('feetAssessToCollectWater', StuckFeetAssessBehavior, StuckCollectWaterBehavior)
      .setShouldTransition((state) => shouldCollectPlacedWater(state))
      .build(),

    getTransition('feetAssessToUseWater', StuckFeetAssessBehavior, StuckUseWaterBehavior)
      .setShouldTransition((state) => {
        if (shouldUseWaterForCobweb(state.bot)) return true
        return shouldUseWaterForLava(state.bot)
      })
      .build(),

    getTransition('feetAssessToUseBucket', StuckFeetAssessBehavior, StuckUseBucketBehavior)
      .setShouldTransition((state) => shouldUseEmptyBucketForLava(state.bot))
      .build(),

    getTransition('feetAssessToBreakFloorCobweb', StuckFeetAssessBehavior, StuckBreakFloorCobwebBehavior)
      .setShouldTransition((state) => shouldBreakFloorCobweb(state.bot))
      .build(),

    getTransition('feetAssessToMoveEscape', StuckFeetAssessBehavior, StuckFeetMoveEscapeBehavior)
      .setShouldTransition((state) => shouldStayInStuck(state))
      .build(),

    getTransition('collectWaterToFeetAssess', StuckCollectWaterBehavior, StuckFeetAssessBehavior)
      .setShouldTransition(isFinished)
      .build(),

    getTransition('useWaterToFeetAssess', StuckUseWaterBehavior, StuckFeetAssessBehavior)
      .setShouldTransition(isFinished)
      .build(),

    getTransition('useBucketToFeetAssess', StuckUseBucketBehavior, StuckFeetAssessBehavior)
      .setShouldTransition(isFinished)
      .build(),

    getTransition('breakFloorCobwebToFeetAssess', StuckBreakFloorCobwebBehavior, StuckFeetAssessBehavior)
      .setShouldTransition(isFinished)
      .build(),

    getTransition('feetMoveEscapeToFeetAssess', StuckFeetMoveEscapeBehavior, StuckFeetAssessBehavior)
      .setShouldTransition(isFinished)
      .build(),
  ]
}
