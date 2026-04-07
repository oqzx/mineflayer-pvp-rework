import type { Entity } from 'prismarine-entity'
export type AttackDebugSnapshot = {
  target: Entity | undefined
  phase: string
  inRange: boolean
  visible: boolean
  ticksToNextAttack: number
  age: number
  cpsElapsedTicks: number
  cpsNextIntervalTicks: number
  cpsReadyInTicks: number
  intendedCps: number
}

export class AttackDebugger {
  constructor(private readonly enabled: boolean) {}

  skip(
    reason: string,
    snapshot: AttackDebugSnapshot,
    details: Record<string, unknown> = {},
  ): void {
    if (!this.enabled) return
    const targetName =
      snapshot.target?.username ??
      snapshot.target?.displayName ??
      snapshot.target?.name ??
      snapshot.target?.id ??
      'none'

    const base: Record<string, unknown> = {
      target: targetName,
      phase: snapshot.phase,
      inRange: snapshot.inRange,
      visible: snapshot.visible,
      ticksToNextAttack: snapshot.ticksToNextAttack,
      cpsElapsedTicks: snapshot.cpsElapsedTicks,
      cpsNextIntervalTicks: snapshot.cpsNextIntervalTicks,
      cpsReadyInTicks: snapshot.cpsReadyInTicks,
      intendedCps: snapshot.intendedCps.toFixed(2),
      ...details,
    }

    console.log(`[attack-debug] ${this.serialize('skip', reason, base)}`)
  }

  hit(snapshot: AttackDebugSnapshot, details: Record<string, unknown> = {}): void {
    if (!this.enabled) return

    const targetName =
      snapshot.target?.username ??
      snapshot.target?.displayName ??
      snapshot.target?.name ??
      snapshot.target?.id ??
      'none'

    const base: Record<string, unknown> = {
      target: targetName,
      phase: snapshot.phase,
      inRange: snapshot.inRange,
      visible: snapshot.visible,
      ticksToNextAttack: snapshot.ticksToNextAttack,
      cpsElapsedTicks: snapshot.cpsElapsedTicks,
      cpsNextIntervalTicks: snapshot.cpsNextIntervalTicks,
      cpsReadyInTicks: snapshot.cpsReadyInTicks,
      intendedCps: snapshot.intendedCps.toFixed(2),
      ...details,
    }

    console.log(`[attack-debug] ${this.serialize('hit', 'attacked', base)}`)
  }

  private serialize(kind: string, reason: string, fields: Record<string, unknown>): string {
    const detailText = Object.entries(fields)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ')
    return `${kind}=${reason} ${detailText}`
  }
}
