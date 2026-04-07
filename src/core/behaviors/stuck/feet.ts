import { StateBehavior, getTransition, behaviors, type StateMachineData } from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import { holdJumpForNextTick } from '../../../util/jump-control.js'
import {
  StuckActionBehavior,
  collectPlacedWater,
  dataOf,
  getFloorTrap,
  getTrapKind,
  isFinished,
  pickUpLavaWithEmptyBucket,
  pickUpLavaWithWater,
  placeWaterNextToTrap,
  shouldCollectPlacedWater,
  shouldStayInStuck,
  shouldUseEmptyBucketForLava,
  shouldUseWaterForCobweb,
  shouldUseWaterForLava,
} from './shared.js'

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

      const placed = await placeWaterNextToTrap(this.bot, floorTrap)
      if (!placed) return

      data.stuckWaterPlaced = true
      data.stuckWaterPlacedTick = data.tick
      return
    }

    if (trapKind === 'lava') {
      const lavaBlock = getFloorTrap(this.bot)
      if (!lavaBlock) return

      const used = await pickUpLavaWithWater(this.bot, lavaBlock)
      if (!used) return

      data.stuckWaterPlaced = true
      data.stuckWaterPlacedTick = data.tick
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
    console.log('collecting')
    const collected = await collectPlacedWater(this.bot)
    if (!collected) return
    data.stuckWaterPlaced = false
    data.stuckWaterPlacedTick = undefined
  }
}

export class StuckFeetMoveEscapeBehavior extends StuckActionBehavior {
  static readonly stateName = 'StuckFeetMoveEscape'

  protected async runAction(): Promise<void> {
    const data = dataOf(this)
    const trapKind = getTrapKind(this.bot)
    const goLeft = data.tick % 12 < 6
    const dir = goLeft ? 'left' : 'right'
    const opposite = goLeft ? 'right' : 'left'

    this.bot.setControlState('back', false)
    this.bot.setControlState('sprint', false)
    this.bot.setControlState('forward', trapKind === 'lava')
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

    getTransition('feetMoveEscapeToFeetAssess', StuckFeetMoveEscapeBehavior, StuckFeetAssessBehavior)
      .setShouldTransition(isFinished)
      .build(),
  ]
}
