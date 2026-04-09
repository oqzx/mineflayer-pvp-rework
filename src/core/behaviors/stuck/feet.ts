import {
  StateBehavior,
  getTransition,
  type StateMachineData,
} from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Vec3 } from 'vec3'
import type { Block } from 'prismarine-block'
import { holdJumpForNextTick } from '../../../util/jump-control.js'
import {
  breakCobweb,
  collectPlacedWater,
  dataOf,
  getFloorTrap,
  getTrapKind,
  isFinished,
  pickUpLavaWithEmptyBucket,
  pickUpLavaWithWater,
  placeWaterNextToTrap,
  StuckActionState,
  shouldBreakFloorCobweb,
  shouldStayInStuck,
  shouldUseEmptyBucketForLava,
  shouldUseWaterForCobweb,
  shouldUseWaterForLava,
  WATER_SETTLE_TICKS,
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

export class StuckUseWaterBehavior extends StuckActionState<[Block | undefined]> {
  static readonly stateName = 'StuckUseWater'
  private placedPos: Vec3 | undefined

  getPlacedPos(): Vec3 | undefined {
    return this.placedPos?.clone()
  }

  protected async performAction(floorTrap?: Block): Promise<void> {
    const data = dataOf(this)
    const trapKind = getTrapKind(this.bot)
    this.placedPos = undefined

    if (trapKind === 'cobweb') {
      if (!floorTrap) return

      const placedPos = await placeWaterNextToTrap(
        this.bot,
        floorTrap,
        data.stuckWaterFailedPlacements,
      )
      if (!placedPos) return

      this.placedPos = placedPos.clone()
      return
    }

    if (trapKind === 'lava') {
      if (!floorTrap) return

      const used = await pickUpLavaWithWater(this.bot, floorTrap)
      if (!used) return

      this.placedPos = floorTrap.position.clone()
    }
  }
}

export class StuckUseBucketBehavior extends StuckActionState<[Block | undefined]> {
  static readonly stateName = 'StuckUseBucket'

  protected async performAction(lavaBlock?: Block): Promise<void> {
    if (!lavaBlock) return
    await pickUpLavaWithEmptyBucket(this.bot, lavaBlock)
  }
}

export class StuckCollectWaterBehavior extends StuckActionState<[Vec3 | undefined]> {
  static readonly stateName = 'StuckCollectWater'

  protected async performAction(placedPos?: Vec3): Promise<void> {
    const data = dataOf(this)
    await this.bot.waitForTicks(WATER_SETTLE_TICKS)

    const collected = await collectPlacedWater(this.bot, placedPos)
    if (!collected) return

    const trapKind = getTrapKind(this.bot)
    const floorTrap = getFloorTrap(this.bot)
    const cobwebStillAtFeet =
      trapKind === 'cobweb' && floorTrap !== undefined && floorTrap.name.includes('web')

    if (cobwebStillAtFeet && placedPos) {
      data.stuckWaterFailedPlacements.add(placedPos.toString())
    }
  }
}

export class StuckBreakFloorCobwebBehavior extends StuckActionState<[Block | undefined]> {
  static readonly stateName = 'StuckBreakFloorCobweb'

  protected async performAction(floorTrap?: Block): Promise<void> {
    if (!floorTrap) return
    await breakCobweb(this.bot, floorTrap)
  }
}

export class StuckFeetMoveEscapeBehavior extends StuckActionState {
  static readonly stateName = 'StuckFeetMoveEscape'

  protected async performAction(): Promise<void> {
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

    getTransition('feetAssessToUseWater', StuckFeetAssessBehavior, StuckUseWaterBehavior)
      .setShouldTransition((state) => {
        if (shouldUseWaterForCobweb(state.bot)) return true
        return shouldUseWaterForLava(state.bot)
      })
      .setRuntimeEnterFn((state) => getFloorTrap(state.bot))
      .build(),

    getTransition('feetAssessToUseBucket', StuckFeetAssessBehavior, StuckUseBucketBehavior)
      .setShouldTransition((state) => shouldUseEmptyBucketForLava(state.bot))
      .setRuntimeEnterFn((state) => getFloorTrap(state.bot))
      .build(),

    getTransition(
      'feetAssessToBreakFloorCobweb',
      StuckFeetAssessBehavior,
      StuckBreakFloorCobwebBehavior,
    )
      .setShouldTransition((state) => shouldBreakFloorCobweb(state.bot))
      .setRuntimeEnterFn((state) => getFloorTrap(state.bot))
      .build(),

    getTransition('feetAssessToMoveEscape', StuckFeetAssessBehavior, StuckFeetMoveEscapeBehavior)
      .setShouldTransition((state) => shouldStayInStuck(state))
      .build(),

    getTransition('useWaterToCollectWater', StuckUseWaterBehavior, StuckCollectWaterBehavior)
      .setShouldTransition((state) => isFinished(state) && state.getPlacedPos() !== undefined)
      .setRuntimeEnterFn((state) => state.getPlacedPos())
      .build(),

    getTransition('collectWaterToFeetAssess', StuckCollectWaterBehavior, StuckFeetAssessBehavior)
      .setShouldTransition(isFinished)
      .build(),

    getTransition('useWaterToFeetAssess', StuckUseWaterBehavior, StuckFeetAssessBehavior)
      .setShouldTransition((state) => isFinished(state) && state.getPlacedPos() === undefined)
      .build(),

    getTransition('useBucketToFeetAssess', StuckUseBucketBehavior, StuckFeetAssessBehavior)
      .setShouldTransition(isFinished)
      .build(),

    getTransition(
      'breakFloorCobwebToFeetAssess',
      StuckBreakFloorCobwebBehavior,
      StuckFeetAssessBehavior,
    )
      .setShouldTransition(isFinished)
      .build(),

    getTransition(
      'feetMoveEscapeToFeetAssess',
      StuckFeetMoveEscapeBehavior,
      StuckFeetAssessBehavior,
    )
      .setShouldTransition(isFinished)
      .build(),
  ]
}
