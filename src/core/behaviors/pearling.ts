import { StateBehavior } from '@nxg-org/mineflayer-static-statemachine'
import type { Bot } from 'mineflayer'
import type { StateMachineData } from '@nxg-org/mineflayer-static-statemachine'
import type { Entity } from 'prismarine-entity'
import type { Vec3 } from 'vec3'
import type { PvpData } from '../pvp-data.js'
import { VOID_DEPTH } from '../../calc/constants.js'
import '@nxg-org/mineflayer-ender'

function findSafeLandingBlock(bot: Bot, searchRadius: number, avoidPositions: Vec3[]) {
  const origin = bot.entity.position
  const candidates: Vec3[] = []
  for (let dx = -searchRadius; dx <= searchRadius; dx += 2) {
    for (let dz = -searchRadius; dz <= searchRadius; dz += 2) {
      const check = origin.offset(dx, 0, dz)
      const ground = bot.blockAt(check.offset(0, -1, 0))
      const air0 = bot.blockAt(check)
      const air1 = bot.blockAt(check.offset(0, 1, 0))
      if (!ground || ground.name === 'air') continue
      if (air0?.name !== 'air' || air1?.name !== 'air') continue
      if (check.y < VOID_DEPTH + 16) continue
      candidates.push(check.clone())
    }
  }
  return (
    candidates
      .filter((p) => avoidPositions.every((ap) => p.distanceTo(ap) > 3))
      .sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin))[0] ?? null
  )
}

function isAboveVoid(bot: Bot): boolean {
  for (let dy = -1; dy >= -VOID_DEPTH; dy--) {
    const block = bot.blockAt(bot.entity.position.offset(0, dy, 0))
    if (block && block.name !== 'air') return false
  }
  return true
}

export class PearlingBehavior extends StateBehavior {
  static readonly stateName = 'Pearling'

  private done = false

  constructor(bot: Bot, data: StateMachineData) {
    super(bot, data)
  }

  onStateEntered(): void {
    this.done = false
    void this.executePearl()
  }

  update(): void {}

  isFinished(): boolean {
    return this.done
  }

  onStateExited(): void {
    this.done = false
    this.bot.ender.cancel()
  }

  private async executePearl(): Promise<void> {
    const d = this.data as PvpData
    if (this.shouldDefensive(d)) {
      await this.throwDefensive(d)
    } else if (d.entity) {
      await this.throwAggressive(d.entity)
    }
    this.done = true
  }

  private shouldDefensive(d: PvpData): boolean {
    if (!d.config.pearl.defensiveEnabled || !this.bot.ender.hasPearls()) return false
    if (isAboveVoid(this.bot) && this.bot.entity.velocity.y < -0.5) return true
    if (this.bot.entity.velocity.y >= -1.0) return false
    let height = 0
    for (let dy = -1; dy >= -20; dy--) {
      const block = this.bot.blockAt(this.bot.entity.position.offset(0, dy, 0))
      if (block && block.name !== 'air') {
        height = Math.abs(dy)
        break
      }
    }
    return Math.max(0, height - 3) >= (this.bot.health ?? 20)
  }

  private async throwAggressive(target: Entity): Promise<void> {
    if (!this.bot.ender.hasPearls()) return
    const landBlock = this.bot.blockAt(target.position.offset(0, -1, 0))
    if (!landBlock || landBlock.name === 'air') return
    console.log(landBlock)
    const shot = this.bot.ender.shotToBlock(landBlock)
    if (shot?.hit) await this.bot.ender.pearl(landBlock)
  }

  private async throwDefensive(d: PvpData): Promise<void> {
    const threats = d.targetSelector.getNearbyThreats(this.bot, d.config.generic.viewDistance)
    const safePos = findSafeLandingBlock(
      this.bot,
      d.config.pearl.safeLandingSearchRadius,
      threats.map((e) => e.position),
    )
    if (!safePos) return
    const safeBlock = this.bot.blockAt(safePos.offset(0, -1, 0))
    if (!safeBlock || safeBlock.name === 'air') return
    const shot = this.bot.ender.shotToBlock(safeBlock)
    if (shot?.hit) await this.bot.ender.pearl(safeBlock)
  }
}
