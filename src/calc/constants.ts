type ProjectileInfo = { v0: number; g: number; drag: number }

export const trajectoryInfo: Record<string, ProjectileInfo> = {
  bow: { v0: 3.0, g: 0.05, drag: 0.99 },
  crossbow: { v0: 3.15, g: 0.05, drag: 0.99 },
  crossbow_firework: { v0: 1.6, g: 0.0, drag: 0.99 },
  trident: { v0: 2.5, g: 0.05, drag: 0.99 },
  snowball: { v0: 1.5, g: 0.03, drag: 0.99 },
  egg: { v0: 1.5, g: 0.03, drag: 0.99 },
  ender_pearl: { v0: 1.5, g: 0.03, drag: 0.99 },
  splash_potion: { v0: 0.4, g: 0.03, drag: 0.99 },
  fireball: { v0: 1.0, g: 0.0, drag: 1.0 },
}

export const airResistance = { y: 0.01, h: 0.01 }

export const TICKS_PER_SECOND = 20
export const MS_PER_TICK = 50
export const MAX_ARROW_TICKS = 120
export const MAX_PEARL_TICKS = 80
export const CRIT_VELOCITY_THRESHOLD = -0.1
export const VOID_DEPTH = -64
