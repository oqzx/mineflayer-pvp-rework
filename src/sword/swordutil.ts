import { Entity } from "prismarine-entity";
import { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { goals } from "mineflayer-pathfinder";
import "mineflayer-pathfinder";
import { FollowConfig, FullConfig } from "./swordconfigs";

class PredictiveGoal extends goals.Goal {
  private readonly rangeSq: number;
  private cachedPos: Vec3;

  constructor(
    private readonly bot: Bot,
    public readonly entity: Entity,
    private readonly range: number,
    private readonly predictTicks: number
  ) {
    super();
    this.rangeSq = range * range;
    this.cachedPos = entity.position.clone();
    this.bot.tracker.trackEntity(entity);
  }

  private computePredictedPosition(): Vec3 {
    if (this.predictTicks === 0) return this.entity.position.clone();
    const vel = (this.bot.tracker as any).getEntitySpeed?.(this.entity) as Vec3 | null ?? new Vec3(0, 0, 0);
    const delta = this.entity.position.minus(this.bot.entity.position);
    const base = Math.sqrt(delta.x * delta.x + delta.y * delta.y + delta.z * delta.z);
    const ticks = Math.round((base * this.predictTicks) / Math.max(1, Math.sqrt(base)));
    return this.entity.position.plus(vel.scaled(isNaN(ticks) ? 0 : ticks));
  }

  heuristic(node: { x: number; y: number; z: number }): number {
    const dx = Math.abs(this.cachedPos.x - node.x);
    const dy = Math.abs(this.cachedPos.y - node.y);
    const dz = Math.abs(this.cachedPos.z - node.z);
    return Math.abs(dx - dz) + Math.min(dx, dz) * Math.SQRT2 + dy;
  }

  isEnd(node: { x: number; y: number; z: number }): boolean {
    const dx = this.cachedPos.x - node.x;
    const dy = this.cachedPos.y - node.y;
    const dz = this.cachedPos.z - node.z;
    return dx * dx + dy * dy + dz * dz <= this.rangeSq;
  }

  hasChanged(): boolean {
    const next = this.computePredictedPosition();
    const dx = next.x - this.cachedPos.x;
    const dy = next.y - this.cachedPos.y;
    const dz = next.z - this.cachedPos.z;
    if (dx * dx + dy * dy + dz * dz > 1) {
      this.cachedPos = next;
      return true;
    }
    return false;
  }
}

export function followEntity(bot: Bot, entity: Entity, options: FullConfig) {
  switch (options.followConfig.mode) {
    case "jump":
    case "standard": {
      const predictTicks =
        options.followConfig.predict ? (options.followConfig.predictTicks ?? 4) : 0;
      const goal = new PredictiveGoal(bot, entity, options.followConfig.distance, predictTicks);
      (bot as any).pathfinder.setGoal(goal, true);
      return goal;
    }
  }
}

export function stopFollow(bot: Bot, _mode: FollowConfig["mode"]) {
  (bot as any).pathfinder.stop();
}
