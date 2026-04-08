import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Vec3 } from 'vec3'

type PearlTrackPhase = 'idle' | 'awaiting-spawn' | 'in-flight' | 'awaiting-teleport'

type PearlTrackState = {
  phase: PearlTrackPhase
  startedAt: number
  throwOrigin: Vec3 | null
  pearlEntityId: number | null
  teleportOrigin: Vec3 | null
}

const SPAWN_RADIUS = 3
const SPAWN_TIMEOUT_MS = 500
const TELEPORT_TIMEOUT_MS = 1500
const TELEPORT_MIN_DISTANCE = 1.5

function now(): number {
  return Date.now()
}

function createIdleState(): PearlTrackState {
  return {
    phase: 'idle',
    startedAt: 0,
    throwOrigin: null,
    pearlEntityId: null,
    teleportOrigin: null,
  }
}

function logTracker(bot: Bot, message: string): void {
  console.log(`[pearl-tracker] bot=${bot.username ?? 'unknown'} ${message}`)
}

export class ThrownPearlTracker {
  private static singleton: ThrownPearlTracker | null = null

  static get instance(): ThrownPearlTracker {
    ThrownPearlTracker.singleton ??= new ThrownPearlTracker()
    return ThrownPearlTracker.singleton
  }

  private readonly states = new WeakMap<Bot, PearlTrackState>()

  private getState(bot: Bot): PearlTrackState {
    const current = this.states.get(bot)
    if (current) return current

    const next = createIdleState()
    this.states.set(bot, next)
    return next
  }

  private reset(bot: Bot): void {
    const state = this.states.get(bot)
    if (state && state.phase !== 'idle') {
      logTracker(bot, `reset from=${state.phase}`)
    }
    this.states.set(bot, createIdleState())
  }

  private expire(bot: Bot): void {
    const state = this.getState(bot)
    const elapsed = now() - state.startedAt

    if (state.phase === 'awaiting-spawn' && elapsed > SPAWN_TIMEOUT_MS) {
      this.reset(bot)
      return
    }

    if (state.phase === 'awaiting-teleport' && elapsed > TELEPORT_TIMEOUT_MS) {
      this.reset(bot)
    }
  }

  isActive(bot: Bot): boolean {
    this.expire(bot)
    return this.getState(bot).phase !== 'idle'
  }

  getPhase(bot: Bot): PearlTrackPhase {
    this.expire(bot)
    return this.getState(bot).phase
  }

  canStartThrow(bot: Bot): boolean {
    return !this.isActive(bot)
  }

  beginThrow(bot: Bot, origin: Vec3): boolean {
    this.expire(bot)
    const state = this.getState(bot)
    if (state.phase !== 'idle') return false

    this.states.set(bot, {
      phase: 'awaiting-spawn',
      startedAt: now(),
      throwOrigin: origin.clone(),
      pearlEntityId: null,
      teleportOrigin: null,
    })
    logTracker(bot, `beginThrow origin=${origin}`)
    return true
  }

  cancelThrow(bot: Bot): void {
    const state = this.getState(bot)
    if (state.phase === 'awaiting-spawn') {
      logTracker(bot, 'cancelThrow while awaiting-spawn')
      this.reset(bot)
    }
  }

  onEntitySpawn(bot: Bot, entity: Entity): void {
    this.expire(bot)
    const state = this.getState(bot)
    if (state.phase !== 'awaiting-spawn') return
    if (!state.throwOrigin) return
    if (!entity.name?.includes('pearl')) return
   
    if (entity.position.distanceTo(state.throwOrigin) > SPAWN_RADIUS) return

    logTracker(bot, `spawn matched entity=${entity.id} name=${entity.name} pos=${entity.position}`)
    this.states.set(bot, {
      phase: 'in-flight',
      startedAt: now(),
      throwOrigin: null,
      pearlEntityId: entity.id,
      teleportOrigin: null,
    })
  }

  onEntityGone(bot: Bot, entity: Entity): void {
    this.expire(bot)
    const state = this.getState(bot)
    if (state.phase !== 'in-flight' || state.pearlEntityId !== entity.id) return

    logTracker(bot, `entity gone entity=${entity.id}; awaiting teleport from=${bot.entity.position}`)
    this.states.set(bot, {
      phase: 'awaiting-teleport',
      startedAt: now(),
      throwOrigin: null,
      pearlEntityId: null,
      teleportOrigin: bot.entity.position.clone(),
    })
  }

  onBotMove(bot: Bot, previousPosition?: Vec3): void {
    this.expire(bot)
    const state = this.getState(bot)
    if (state.phase !== 'awaiting-teleport') return

    const origin = state.teleportOrigin ?? previousPosition ?? bot.entity.position.clone()
    if (bot.entity.position.distanceTo(origin) < TELEPORT_MIN_DISTANCE) return

    logTracker(bot, `teleport detected from=${origin} to=${bot.entity.position}`)
    this.reset(bot)
  }

  onForcedMove(bot: Bot): void {
    this.onBotMove(bot)
  }
}
