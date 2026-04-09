import type { Bot } from "mineflayer"
import { goals } from "mineflayer-pathfinder"
import type { Entity } from "prismarine-entity"
import { Vec3 } from "vec3"

export class FollowGoal extends goals.Goal {
  private readonly rangeSq: number
  private cachedPos: Vec3

  constructor(
    private readonly bot: Bot,
    private readonly entity: Entity,
    range: number,
    private readonly predictTicks: number,
  ) {
    super()
    this.rangeSq = range * range
    this.cachedPos = entity.position.clone()
  }

  heuristic(n: { x: number; y: number; z: number }): number {
    const dx = Math.abs(this.cachedPos.x - n.x)
    const dy = Math.abs(this.cachedPos.y - n.y)
    const dz = Math.abs(this.cachedPos.z - n.z)
    return Math.abs(dx - dz) + Math.min(dx, dz) * Math.SQRT2 + dy
  }

  isEnd(n: { x: number; y: number; z: number }): boolean {
    const dx = this.cachedPos.x - n.x
    const dy = this.cachedPos.y - n.y
    const dz = this.cachedPos.z - n.z
    return dx * dx + dy * dy + dz * dz <= this.rangeSq
  }

  hasChanged(): boolean {
    type Tracker = { getEntitySpeed?: (e: Entity) => Vec3 | null }
    const vel =
      (this.bot.tracker as unknown as Tracker).getEntitySpeed?.(this.entity) ?? new Vec3(0, 0, 0)
    const predicted = this.entity.position.plus(vel.scaled(this.predictTicks))
    const dx = predicted.x - this.cachedPos.x
    const dy = predicted.y - this.cachedPos.y
    const dz = predicted.z - this.cachedPos.z
    if (dx * dx + dy * dy + dz * dz > 1) {
      this.cachedPos = predicted
      return true
    }
    return false
  }
}
