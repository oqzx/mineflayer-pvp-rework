import type { Bot, ControlState } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import {
  ShotFactory,
  InterceptFunctions,
  projectileGravity,
} from '@nxg-org/mineflayer-trajectories';
import type { DodgeConfig } from '../config/types.js';
import type { IncomingProjectile } from '../core/combat-state.js';
import { vectorMagnitude } from '../calc/math.js';
import { randomIntInRange, delay } from '../util/humanizer.js';

const FIREBALL_ENTITY_NAMES = new Set([
  'fireball',
  'small_fireball',
  'wither_skull',
]);
const ARROW_ENTITY_NAMES = ['arrow', 'spectral_arrow', 'trident'];
const KNOWN_LIBRARY_PROJECTILES = new Set(Object.keys(projectileGravity));

const BOT_AABB_HEIGHT_PADDING = 0.18;
const BOT_AABB_WIDTH = 0.6;
const FIREBALL_DRAG = 0.95;
const FIREBALL_SIM_TICKS = 120;
const MIN_VELOCITY_THRESHOLD = 0.01;
const HISTORY_MAX = 6;

type PosSample = {
  pos: Vec3;
  time: number;
};

export function classifyProjectile(
  entity: Entity,
): IncomingProjectile['type'] | null {
  const name = entity.name?.toLowerCase() ?? '';
  if (ARROW_ENTITY_NAMES.some((p) => name.includes(p))) return 'arrow';
  if (FIREBALL_ENTITY_NAMES.has(name)) return 'fireball';
  if (name === 'ender_pearl') return 'pearl';
  return null;
}

export class ProjectileScanner {
  private readonly intercepter: InterceptFunctions;
  private readonly history = new Map<number, PosSample[]>();

  constructor(private readonly bot: Bot) {
    this.intercepter = new InterceptFunctions(bot);
  }

  record(entity: Entity): void {
    const samples = this.history.get(entity.id) ?? [];
    const last = samples.at(-1);
    if (last && last.pos.equals(entity.position)) return;
    samples.push({
      pos: entity.position.clone(),
      time: Date.now(),
    });
    if (samples.length > HISTORY_MAX) samples.shift();
    this.history.set(entity.id, samples);
  }

  forget(entityId: number): void {
    this.history.delete(entityId);
  }

  private deriveVelocity(entity: Entity): Vec3 {
    const reported = entity.velocity;
    if (vectorMagnitude(reported) > MIN_VELOCITY_THRESHOLD)
      return reported.clone();

    const samples = this.history.get(entity.id);
    if (!samples || samples.length < 2) return reported.clone();

    const a = samples[samples.length - 2]!;
    const b = samples[samples.length - 1]!;
    const dtMs = b.time - a.time;
    if (dtMs < 1) return reported.clone();

    const scale = 50 / dtMs;
    return new Vec3(
      (b.pos.x - a.pos.x) * scale,
      (b.pos.y - a.pos.y) * scale,
      (b.pos.z - a.pos.z) * scale,
    );
  }

  private patchedEntity(entity: Entity): Entity {
    const vel = this.deriveVelocity(entity);
    return new Proxy(entity, {
      get(target, prop, receiver) {
        if (prop === 'velocity') return vel;
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  private hitsTargetViaLibrary(
    projectile: Entity,
    target: Entity,
  ): { totalTicks: number; impactPosition: Vec3 } | null {
    const patched = this.patchedEntity(projectile);
    if (vectorMagnitude(patched.velocity) < MIN_VELOCITY_THRESHOLD) return null;

    const aabb = {
      position: target.position,
      height: (target.height ?? 1.8) + BOT_AABB_HEIGHT_PADDING,
      width: BOT_AABB_WIDTH,
    };

    const result = ShotFactory.fromEntity(patched, this.intercepter).hitsEntity(
      aabb,
    );
    if (!result || result.shotInfo.nearestDistance > 0) return null;

    return {
      totalTicks: result.shotInfo.totalTicks,
      impactPosition:
        (result as { intersectPos?: Vec3 }).intersectPos ??
        projectile.position.clone(),
    };
  }

  private hitsTargetFireball(
    projectile: Entity,
    target: Entity,
  ): { totalTicks: number; impactPosition: Vec3 } | null {
    const vel = this.deriveVelocity(projectile);
    if (vectorMagnitude(vel) < MIN_VELOCITY_THRESHOLD) return null;

    const pos = projectile.position.clone();
    const simVel = vel.clone();
    const halfW = BOT_AABB_WIDTH / 2;
    const height = (target.height ?? 1.8) + BOT_AABB_HEIGHT_PADDING;
    const targetPos = target.position;

    for (let t = 1; t <= FIREBALL_SIM_TICKS; t++) {
      simVel.x *= FIREBALL_DRAG;
      simVel.y *= FIREBALL_DRAG;
      simVel.z *= FIREBALL_DRAG;
      pos.x += simVel.x;
      pos.y += simVel.y;
      pos.z += simVel.z;

      if (pos.y < -64) break;

      if (
        pos.x >= targetPos.x - halfW &&
        pos.x <= targetPos.x + halfW &&
        pos.z >= targetPos.z - halfW &&
        pos.z <= targetPos.z + halfW &&
        pos.y >= targetPos.y &&
        pos.y <= targetPos.y + height
      ) {
        return {
          totalTicks: t,
          impactPosition: pos.clone(),
        };
      }
    }

    return null;
  }

  hitsTarget(
    projectile: Entity,
    target: Entity,
  ): { totalTicks: number; impactPosition: Vec3 } | null {
    const type = classifyProjectile(projectile);
    if (!type) return null;

    if (type === 'fireball') return this.hitsTargetFireball(projectile, target);

    const name = projectile.name ?? '';
    if (!KNOWN_LIBRARY_PROJECTILES.has(name)) return null;

    return this.hitsTargetViaLibrary(projectile, target);
  }

  chooseDodgeDir(projectile: Entity): ControlState {
    const vel = this.deriveVelocity(projectile);
    const speed = vectorMagnitude(vel);
    if (speed < MIN_VELOCITY_THRESHOLD) return 'left';
    const dir = new Vec3(vel.x / speed, 0, vel.z / speed);
    const rightPerp = new Vec3(dir.z, 0, -dir.x);
    const toBot = this.bot.entity.position.minus(projectile.position);
    const dot = toBot.x * rightPerp.x + toBot.z * rightPerp.z;
    return dot >= 0 ? 'right' : 'left';
  }

  scan(currentTick: number): IncomingProjectile[] {
    const liveIds = new Set<number>();
    const incoming: IncomingProjectile[] = [];

    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || entity === this.bot.entity) continue;
      const type = classifyProjectile(entity);
      if (!type) continue;

      liveIds.add(entity.id);
      this.record(entity);

      const hit = this.hitsTarget(entity, this.bot.entity);
      if (!hit) continue;

      incoming.push({
        entity,
        type,
        estimatedImpactTick: currentTick + hit.totalTicks,
        impactPosition: hit.impactPosition,
      });
    }

    for (const id of this.history.keys()) {
      if (!liveIds.has(id)) this.forget(id);
    }

    incoming.sort((a, b) => a.estimatedImpactTick - b.estimatedImpactTick);
    return incoming;
  }
}

export class DodgeController {
  private dodging = false;
  private deflecting = false;

  constructor(
    private readonly config: DodgeConfig,
    private readonly scanner: ProjectileScanner,
  ) {}

  async handleIncoming(
    bot: Bot,
    projectile: IncomingProjectile,
  ): Promise<void> {
    if (!this.config.enabled || this.dodging) return;

    if (projectile.type === 'fireball') {
      const dist = bot.entity.position.distanceTo(projectile.entity.position);
      if (dist <= 4.5) {
        await this.deflectFireball(bot, projectile.entity);
        return;
      }
    }

    await this.dodgeProjectile(bot, projectile.entity);
  }

  private async dodgeProjectile(bot: Bot, projectile: Entity): Promise<void> {
    this.dodging = true;
    const delayTicks = randomIntInRange(this.config.reactionDelay);
    if (delayTicks > 0) await bot.waitForTicks(delayTicks);

    const dodgeDir = this.scanner.chooseDodgeDir(projectile);
    const opposite: ControlState = dodgeDir === 'left' ? 'right' : 'left';

    bot.setControlState(dodgeDir, true);
    bot.setControlState(opposite, false);
    await bot.waitForTicks(4);
    bot.setControlState(dodgeDir, false);
    this.dodging = false;
  }

  private async deflectFireball(bot: Bot, fireball: Entity): Promise<void> {
    if (this.deflecting) return;
    this.deflecting = true;

    const center = fireball.position.offset(0, fireball.height / 2, 0);
    await bot.lookAt(center, true);

    for (let i = 0; i < 6; i++) {
      bot.attack(fireball);
      await delay(randomIntInRange({ min: 40, max: 80 }));
    }

    this.deflecting = false;
  }
}
