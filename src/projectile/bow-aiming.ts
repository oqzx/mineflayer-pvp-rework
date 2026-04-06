import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import type { BowConfig } from '../config/types.js';
import { solveAimIterative } from './trajectory.js';
import type { SolvedAim } from './trajectory.js';

export type AimResult = SolvedAim & {
  weaponName: string;
  knockbackDir?: Vec3;
};

function getEntityVelocity(bot: Bot, entity: Entity): Vec3 {
  return (
    (bot as unknown as { tracker?: { getEntitySpeed(e: Entity): Vec3 | null } }).tracker?.getEntitySpeed(entity) ??
    new Vec3(0, 0, 0)
  );
}

function detectBridgeOrEdge(bot: Bot, target: Entity): Vec3 | null {
  const targetPos = target.position;
  const directions = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

  for (const dir of directions) {
    const checkPos = targetPos.plus(dir.scaled(1.5));
    let hasGround = false;
    for (let dy = -1; dy >= -4; dy--) {
      const block = bot.blockAt(checkPos.offset(0, dy, 0));
      if (block && block.name !== 'air') {
        hasGround = true;
        break;
      }
    }
    if (!hasGround) return dir;
  }

  const below = bot.blockAt(targetPos.offset(0, -1, 0));
  if (!below || below.name === 'air') {
    let dropDepth = 0;
    for (let dy = -1; dy >= -10; dy--) {
      const b = bot.blockAt(targetPos.offset(0, dy, 0));
      if (b && b.name !== 'air') break;
      dropDepth++;
    }
    if (dropDepth >= 3) {
      const toBot = bot.entity.position.minus(targetPos);
      return new Vec3(-toBot.x, 0, -toBot.z).normalize();
    }
  }

  return null;
}

export function computeKnockbackAim(bot: Bot, target: Entity, edgeDir: Vec3, weaponName: string): SolvedAim | null {
  const offsetTarget = target.position.plus(edgeDir.scaled(0.8));
  const vel = getEntityVelocity(bot, target);
  const eyePos = bot.entity.position.offset(0, bot.entity.height * 0.9, 0);

  return solveAimIterative(eyePos, { position: offsetTarget, velocity: vel, height: target.height }, weaponName, 6);
}

export class BowAiming {
  constructor(private readonly config: BowConfig) {}

  compute(bot: Bot, target: Entity, weaponName: string): AimResult | null {
    const eyePos = bot.entity.position.offset(0, bot.entity.height * 0.9, 0);
    const vel = getEntityVelocity(bot, target);

    if (this.config.bridgeKnockbackEnabled) {
      const edgeDir = detectBridgeOrEdge(bot, target);
      if (edgeDir) {
        const knockbackAim = computeKnockbackAim(bot, target, edgeDir, weaponName);
        if (knockbackAim) {
          return { ...knockbackAim, weaponName, knockbackDir: edgeDir };
        }
      }
    }

    const aim = solveAimIterative(
      eyePos,
      { position: target.position, velocity: vel, height: target.height },
      weaponName,
      this.config.leadIterations,
    );

    return aim ? { ...aim, weaponName } : null;
  }
}
