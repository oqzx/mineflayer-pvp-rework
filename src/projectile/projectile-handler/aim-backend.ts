import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Vec3 } from 'vec3'
import type { BowConfig } from '../../config/types.js'
import { BowAiming } from './bow-aiming.js'
import { type CheckedShot, ShotPlanner } from './shot-planner.js'

export type ProjectileAimResult = {
  hit: boolean
  yaw: number
  pitch: number
  ticks: number
}

export interface ProjectileAimBackend {
  compute(target: Entity, weapon: string, velocity: Vec3): ProjectileAimResult | null
}

class ShotPlannerBackend implements ProjectileAimBackend {
  private readonly planner: ShotPlanner

  constructor(bot: Bot) {
    this.planner = new ShotPlanner(bot)
  }

  compute(target: Entity, weapon: string, velocity: Vec3): ProjectileAimResult | null {
    this.planner.weapon = weapon
    const shot = this.planner.shotToEntity(target, velocity)
    return normalizePlannerShot(shot)
  }
}

class BowAimingBackend implements ProjectileAimBackend {
  private readonly aiming: BowAiming

  constructor(
    private readonly bot: Bot,
    bowConfig: BowConfig,
  ) {
    this.aiming = new BowAiming(bowConfig)
  }

  compute(target: Entity, weapon: string): ProjectileAimResult | null {
    const shot = this.aiming.compute(this.bot, target, weapon)
    if (!shot) return null

    return {
      hit: true,
      yaw: shot.yaw,
      pitch: shot.pitch,
      ticks: shot.flightTicks,
    }
  }
}

function normalizePlannerShot(shot: CheckedShot | null): ProjectileAimResult | null {
  if (!shot) return null

  return {
    hit: shot.hit,
    yaw: shot.yaw,
    pitch: shot.pitch,
    ticks: shot.ticks,
  }
}

export function createProjectileAimBackend(bot: Bot, bowConfig: BowConfig): ProjectileAimBackend {
  if (bowConfig.aimBackend === 'bow-aiming') {
    return new BowAimingBackend(bot, bowConfig)
  }

  return new ShotPlannerBackend(bot)
}
