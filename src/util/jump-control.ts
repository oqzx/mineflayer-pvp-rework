import type { Bot, ControlState } from 'mineflayer'

type JumpTracker = {
  touchVersion: number
  installed: boolean
  releaseAtTick: number | null
  tickCounter: number
}

type BotWithPatchedJump = Bot & {
  setControlState(state: ControlState, value: boolean): void
}

const trackers = new WeakMap<Bot, JumpTracker>()

function getTracker(bot: Bot): JumpTracker {
  let tracker = trackers.get(bot)
  if (!tracker) {
    tracker = {
      touchVersion: 0,
      installed: false,
      releaseAtTick: null,
      tickCounter: 0,
    }
    trackers.set(bot, tracker)
  }
  return tracker
}

function installJumpTracker(bot: BotWithPatchedJump): JumpTracker {
  const tracker = getTracker(bot)
  if (tracker.installed) return tracker

  const original = bot.setControlState.bind(bot)
  bot.setControlState = ((state: ControlState, value: boolean): void => {
    if (state === 'jump') tracker.touchVersion++
    original(state, value)
  }) as typeof bot.setControlState

  const currentMax = bot.getMaxListeners()
  if (currentMax !== 0) bot.setMaxListeners(currentMax + 1)

  bot.on('physicsTick', () => {
    tracker.tickCounter++
    if (tracker.releaseAtTick === null || tracker.tickCounter < tracker.releaseAtTick) return

    tracker.releaseAtTick = null
    if (bot.getControlState('jump')) {
      bot.setControlState('jump', false)
    }
  })

  tracker.installed = true
  return tracker
}

export function holdJumpForNextTick(bot: Bot): void {
  const trackedBot = bot as BotWithPatchedJump
  const tracker = installJumpTracker(trackedBot)

  trackedBot.setControlState('jump', true)
  tracker.releaseAtTick = tracker.tickCounter + 1
}
