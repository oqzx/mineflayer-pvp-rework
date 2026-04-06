import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';

const STRUGGLING_HEALTH_THRESHOLD = 8;
const ASSIST_RANGE = 20;

export type TeammateStatus = {
  entity: Entity;
  health: number;
  isStruggling: boolean;
  nearestEnemy: Entity | undefined;
};

export class TeamHandler {
  constructor(
    private readonly bot: Bot,
    private readonly teammates: string[],
  ) {}

  isTeammate(entity: Entity): boolean {
    return this.teammates.includes(entity.username ?? '') || this.teammates.includes(entity.name ?? '');
  }

  getStruggling(): TeammateStatus[] {
    const statuses: TeammateStatus[] = [];

    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || !this.isTeammate(entity)) continue;
      const dist = this.bot.entity.position.distanceTo(entity.position);
      if (dist > ASSIST_RANGE) continue;

      const health = (entity.metadata[9] as number | undefined) ?? 20;
      const isStruggling = health <= STRUGGLING_HEALTH_THRESHOLD;

      const nearestEnemy = this.findNearestEnemy(entity);
      statuses.push({ entity, health, isStruggling, nearestEnemy });
    }

    return statuses.filter((s) => s.isStruggling && s.nearestEnemy !== undefined);
  }

  private findNearestEnemy(teammate: Entity): Entity | undefined {
    let nearest: Entity | undefined;
    let nearestDist = 8;

    for (const e of Object.values(this.bot.entities)) {
      if (!e || e === this.bot.entity) continue;
      if (this.isTeammate(e)) continue;
      if (e.type !== 'player' && e.type !== 'hostile') continue;
      const d = teammate.position.distanceTo(e.position);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = e;
      }
    }
    return nearest;
  }
}
