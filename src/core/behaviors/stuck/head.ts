import {
  StateBehavior,
  getTransition,
  type StateMachineData,
} from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import {
  breakCobweb,
  getFaceCobweb,
  isFinished,
  StuckActionState,
  shouldBreakFaceCobweb,
  shouldStayInStuck,
} from './shared.js'

export class StuckHeadAssessBehavior extends StateBehavior {
  static readonly stateName = 'StuckHeadAssess'

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

export class StuckBreakCobwebBehavior extends StuckActionState<[Block | undefined]> {
  static readonly stateName = 'StuckBreakCobweb'

  protected async performAction(faceCobweb?: Block): Promise<void> {
    if (!faceCobweb) return
    await breakCobweb(this.bot, faceCobweb)
  }
}

export class StuckHeadMoveEscapeBehavior extends StuckActionState {
  static readonly stateName = 'StuckHeadMoveEscape'

  protected async performAction(): Promise<void> {
    this.bot.setControlState('back', true)
    this.bot.setControlState('forward', false)
    this.bot.setControlState('sprint', false)
    await this.bot.waitForTicks(1)
  }
}

export function buildHeadStuckTransitions(exitState: typeof StateBehavior) {
  return [
    getTransition('headAssessToExit', StuckHeadAssessBehavior, exitState)
      .setShouldTransition((state) => !shouldStayInStuck(state))
      .build(),

    getTransition('headAssessToBreakCobweb', StuckHeadAssessBehavior, StuckBreakCobwebBehavior)
      .setShouldTransition((state) => shouldBreakFaceCobweb(state.bot))
      .setRuntimeEnterFn((state) => getFaceCobweb(state.bot))
      .build(),

    getTransition('headAssessToMoveEscape', StuckHeadAssessBehavior, StuckHeadMoveEscapeBehavior)
      .setShouldTransition((state) => shouldStayInStuck(state))
      .build(),

    getTransition('breakCobwebToAssess', StuckBreakCobwebBehavior, StuckHeadAssessBehavior)
      .setShouldTransition(isFinished)
      .build(),

    getTransition('headMoveEscapeToAssess', StuckHeadMoveEscapeBehavior, StuckHeadAssessBehavior)
      .setShouldTransition(isFinished)
      .build(),
  ]
}
