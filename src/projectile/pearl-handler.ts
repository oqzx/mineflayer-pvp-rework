import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Vec3 } from 'vec3';
import type { PearlConfig } from '../config/types.js';
import { simulateProjectile, closestApproachTick } from './trajectory.js';
import { VOID_DEPTH } from '../calc/constants.js';

export type PearlUsageReason = 'aggressive' | 'escape-void' | 'escape-fall' | 'repositioning';

type PearlAim = { yaw: number; pitch: number; landingPos: Vec3 };

export type EnemyPearlPrediction = {
  entity: Entity;
  estimatedLandTick: number;
  estimatedLandPos: Vec3;
};

function hasItemInInventory(bot: Bot, name: string): boolean {
  return bot.inventory.items().some((i) => i.name === name);
}

function findSafeLanding(bot: Bot, searchRadius: number, avoidPositions: Vec3[]): Vec3 | null {
  const origin = bot.entity.position;
  const candidates: Vec3[] = [];

  for (let dx = -searchRadius; dx <= searchRadius; dx += 2) {
    for (let dz = -searchRadius; dz <= searchRadius; dz += 2) {
      const check = origin.offset(dx, 0, dz);
      const ground = bot.blockAt(check.offset(0, -1, 0));
      const air1 = bot.blockAt(check);
      const air2 = bot.blockAt(check.offset(0, 1, 0));
      if (!ground || ground.name === 'air') continue;
      if (air1?.name !== 'air' || air2?.name !== 'air') continue;
      if (check.y < VOID_DEPTH + 16) continue;
      candidates.push(check.clone());
    }
  }

  return (
    candidates
      .filter((pos) => avoidPositions.every((ap) => pos.distanceTo(ap) > 3))
      .sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin))[0] ?? null
  );
}

function aimToPosition(origin: Vec3, target: Vec3): PearlAim | null {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;
  const hDist = Math.sqrt(dx * dx + dz * dz);
  const yaw = Math.atan2(dx, dz) + Math.PI;

  for (let pitch = -Math.PI / 2; pitch <= Math.PI / 4; pitch += Math.PI / 180) {
    const sim = simulateProjectile(origin, yaw, pitch, 'ender_pearl', 80);
    const closestTick = closestApproachTick(sim.points, target);
    const pt = sim.points[closestTick - 1];
    if (!pt) continue;
    if (pt.position.distanceTo(target) < 1.5) {
      return { yaw, pitch, landingPos: pt.position.clone() };
    }
  }

  if (hDist > 0) {
    const roughPitch = Math.atan2(dy, hDist) * 0.6;
    return { yaw, pitch: roughPitch, landingPos: target };
  }
  return null;
}

function isAboveVoid(bot: Bot): boolean {
  const pos = bot.entity.position;
  for (let dy = -1; dy >= -VOID_DEPTH; dy--) {
    const block = bot.blockAt(pos.offset(0, dy, 0));
    if (block && block.name !== 'air') return false;
  }
  return true;
}

function estimateFallDamage(height: number): number {
  return Math.max(0, height - 3);
}

export class PearlHandler {
  private throwing: boolean = false;
  private readonly enemyPearlPredictions = new Map<number, EnemyPearlPrediction>();

  constructor(private readonly config: PearlConfig) {}

  get isThrowing(): boolean {
    return this.throwing;
  }

  trackEnemyPearl(entity: Entity, tick: number): void {
    const sim = simulateProjectile(entity.position, entity.yaw, entity.pitch, 'ender_pearl', 80);
    const finalPos = sim.finalPosition;
    this.enemyPearlPredictions.set(entity.id, {
      entity,
      estimatedLandTick: tick + sim.totalTicks,
      estimatedLandPos: finalPos,
    });
  }

  getEnemyPearlPredictions(): EnemyPearlPrediction[] {
    return Array.from(this.enemyPearlPredictions.values());
  }

  removeEnemyPearl(entityId: number): void {
    this.enemyPearlPredictions.delete(entityId);
  }

  shouldThrowAggressive(bot: Bot, target: Entity): boolean {
    if (!this.config.enabled || this.throwing) return false;
    if (!hasItemInInventory(bot, 'ender_pearl')) return false;
    const dist = bot.entity.position.distanceTo(target.position);
    return dist > this.config.aggressiveRange;
  }

  shouldThrowDefensive(bot: Bot): boolean {
    if (!this.config.defensiveEnabled || this.throwing) return false;
    if (!hasItemInInventory(bot, 'ender_pearl')) return false;

    if (isAboveVoid(bot) && bot.entity.velocity.y < -0.5) return true;

    const vel = bot.entity.velocity;
    const fallingFast = vel.y < -1.0;
    if (!fallingFast) return false;

    let height = 0;
    for (let dy = -1; dy >= -20; dy--) {
      const block = bot.blockAt(bot.entity.position.offset(0, dy, 0));
      if (block && block.name !== 'air') {
        height = Math.abs(dy);
        break;
      }
    }

    const fallDamage = estimateFallDamage(height);
    return fallDamage >= (bot.health ?? 20);
  }

  async throwAggressive(bot: Bot, target: Entity): Promise<boolean> {
    const aim = aimToPosition(bot.entity.position, target.position.offset(0, target.height * 0.5, 0));
    if (!aim) return false;
    return this.throw(bot, aim.yaw, aim.pitch);
  }

  async throwDefensive(bot: Bot, enemies: Entity[]): Promise<boolean> {
    const enemyPositions = enemies.map((e) => e.position);
    const safe = findSafeLanding(bot, this.config.safeLandingSearchRadius, enemyPositions);
    if (!safe) return false;
    const aim = aimToPosition(bot.entity.position, safe);
    if (!aim) return false;
    return this.throw(bot, aim.yaw, aim.pitch);
  }

  private async throw(bot: Bot, yaw: number, pitch: number): Promise<boolean> {
    if (this.throwing) return false;
    const pearl = bot.inventory.items().find((i) => i.name === 'ender_pearl');
    if (!pearl) return false;

    this.throwing = true;
    try {
      await bot.util.inv.customEquip(pearl, 'hand');
      await bot.look(yaw, pitch, true);
      bot.activateItem(false);
      await bot.waitForTicks(2);
      return true;
    } finally {
      this.throwing = false;
    }
  }
}
