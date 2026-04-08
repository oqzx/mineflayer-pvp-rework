import {
  StateBehavior,
  getNestedMachine,
  getTransition,
  behaviors,
  type StateMachineData,
} from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { PvpData } from '../../pvp-data.js'
import {
  enterStuckState,
  exitStuckState,
  isFeetStuck,
  isFinished,
  isHeadStuck,
  isStuck,
  shouldStayInStuck,
} from './shared.js'
import { buildHeadStuckTransitions, StuckHeadAssessBehavior } from './head.js'
import { buildFeetStuckTransitions, StuckFeetAssessBehavior } from './feet.js'

class StuckAssessBehavior extends StateBehavior {
  static readonly stateName = 'StuckAssess'

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

const stuckTransitions = [
  getTransition('assessToExit', StuckAssessBehavior, behaviors.BehaviorExit)
    .setShouldTransition((state) => !shouldStayInStuck(state))
    .build(),

  getTransition('assessToHeadAssess', StuckAssessBehavior, StuckHeadAssessBehavior)
    .setShouldTransition((state) => isHeadStuck(state.bot))
    .build(),

  getTransition('assessToFeetAssess', StuckAssessBehavior, StuckFeetAssessBehavior)
    .setShouldTransition((state) => isFeetStuck(state.bot))
    .build(),

  ...buildHeadStuckTransitions(behaviors.BehaviorExit),
  ...buildFeetStuckTransitions(behaviors.BehaviorExit),
]

export const StuckBehavior = getNestedMachine(
  'Stuck',
  stuckTransitions,
  StuckAssessBehavior,
  behaviors.BehaviorExit,
).build()

export function buildStuckTransitions(exitState: typeof StateBehavior) {
  const anyToStuck = getTransition('isStuck', behaviors.BehaviorWildcard, StuckBehavior)
    .setShouldTransition((state) => isStuck(state.bot))
    .setOnTransition((_state, data) => {
      enterStuckState(data as PvpData)
    })
    .build()

  const stuckToIdle = getTransition('stuckToExit', StuckBehavior, exitState)
    .setShouldTransition(isFinished)
    .setOnTransition((_state, data) => {
      exitStuckState(data as PvpData)
    })
    .build()

  return [anyToStuck, stuckToIdle]
}

export { isStuck }
