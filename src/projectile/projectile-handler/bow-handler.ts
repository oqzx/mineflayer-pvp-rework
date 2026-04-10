import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { performance } from 'perf_hooks'
import { promisify } from 'util'
import type { BowConfig, FireballConfig } from '../../config/types.js'
import {
  createProjectileAimBackend,
  type ProjectileAimBackend,
  type ProjectileAimResult,
} from './aim-backend.js'

import { Vec3 } from 'vec3'
const sleep = promisify(setTimeout)
const AIM_EPSILON = 1e-2
const CHARGE_WEAPONS = new Set(['bow', 'crossbow', 'crossbow_firework', 'trident'])
const THROW_WEAPONS = new Set(['snowball', 'ender_pearl', 'egg', 'splash_potion'])
const RANGED_PRIORITY = ['bow', 'crossbow', 'crossbow_firework'] as const
const PHYSICS_DT_SECONDS = 1 / 20
const VELOCITY_SAMPLE_WINDOW = 8
const VELOCITY_EMA_ALPHA = 0.35

type RangedWeapon =
  | (typeof RANGED_PRIORITY)[number]
  | 'trident'
  | 'snowball'
  | 'ender_pearl'
  | 'egg'
  | 'splash_potion'

function deltaRad(yaw1: number, yaw2: number) {
  const PI = Math.PI
  const PI_2 = Math.PI * 2
  let dYaw = (yaw1 - yaw2) % PI_2
  if (dYaw < -PI) dYaw += PI_2
  else if (dYaw > PI) dYaw -= PI_2
  return dYaw
}

type VelocitySample = {
  pos: Vec3
  timestamp: number
}

class LocalEntityVelocityTracker {
  private readonly samples = new Map<number, VelocitySample[]>()
  private readonly smoothedVelocity = new Map<number, Vec3>()

  record(entity: Entity, timestamp: number): void {
    const id = entity.id
    const history = this.samples.get(id) ?? []
    history.push({ pos: entity.position.clone(), timestamp })
    if (history.length > VELOCITY_SAMPLE_WINDOW) history.shift()
    this.samples.set(id, history)

    if (history.length < 2) return
    const prev = history[history.length - 2]!
    const curr = history[history.length - 1]!
    const dt = Math.max((curr.timestamp - prev.timestamp) / 1000, PHYSICS_DT_SECONDS)
    const instant = curr.pos.minus(prev.pos).scaled(1 / dt)
    const current = this.smoothedVelocity.get(id) ?? new Vec3(0, 0, 0)
    const next = current.scaled(1 - VELOCITY_EMA_ALPHA).plus(instant.scaled(VELOCITY_EMA_ALPHA))
    this.smoothedVelocity.set(id, next)
  }

  get(entity: Entity): Vec3 {
    return this.smoothedVelocity.get(entity.id)?.clone() ?? new Vec3(0, 0, 0)
  }

  clear(entity: Entity): void {
    this.samples.delete(entity.id)
    this.smoothedVelocity.delete(entity.id)
  }
}

export class BowPVP {
  public enabled: boolean = false
  public weapon: RangedWeapon = 'bow'
  public useOffhand: boolean = false
  public target: Entity | null = null
  public shotInfo: ProjectileAimResult | null = null
  private shotInit: number = performance.now()
  private shotCharging: boolean = false
  private crossbowLoading: boolean = false
  private aimer: ProjectileAimBackend

  private waitTime: number = 1200

  private lastSentYaw: number = NaN
  private lastSentPitch: number = NaN
  private readonly trackSentRotation: () => void
  private awaitingRelease: boolean = false
  private engageRequestId: number = 0
  private engagingTargetId: number | null = null
  private readonly localVelocityTracker = new LocalEntityVelocityTracker()

  constructor(
    private bot: Bot,
    bowConfig?: BowConfig,
    _fireballConfig?: FireballConfig,
  ) {
    const resolvedBowConfig: BowConfig = bowConfig ?? {
      enabled: true,
      preferOverFireball: true,
      aimBackend: 'bow-aiming',
      leadIterations: 8,
      bridgeKnockbackEnabled: true,
    }

    this.aimer = createProjectileAimBackend(bot, resolvedBowConfig)
    this.trackSentRotation = this.captureSentRotation.bind(this)
    this.captureSentRotation()

    this.bot.on('entityGone', (e) => {
      if (e === this.target) void this.stop()
    })
  }

  public isActive(): boolean {
    return this.enabled
  }

  public canEngage(): boolean {
    return this.getPreferredWeapon() !== null
  }

  public canEngageTarget(target: Entity): boolean {
    const weapon = this.getPreferredWeapon()
    if (!weapon) return false

    const shot = this.shotToEntity(target, this.getVelocity(target), weapon)
    return !!shot?.hit
  }

  private get shotReady(): boolean {
    return performance.now() - this.shotInit >= this.waitTime
  }

  private captureSentRotation(): void {
    this.lastSentYaw = this.bot.entity.yaw
    this.lastSentPitch = this.bot.entity.pitch
  }

  private isAligned(yaw: number, pitch: number, epsilon: number = AIM_EPSILON): boolean {
    if (!Number.isFinite(this.lastSentYaw) || !Number.isFinite(this.lastSentPitch)) {
      return false
    }

    return (
      Math.abs(deltaRad(yaw, this.lastSentYaw)) < epsilon &&
      Math.abs(deltaRad(pitch, this.lastSentPitch)) < epsilon
    )
  }

  private async ensureLookedAt(
    yaw: number,
    pitch: number,
    epsilon: number = AIM_EPSILON,
  ): Promise<boolean> {
    while (this.enabled && this.shotCharging) {
      await this.bot.look(yaw, pitch, true)
      if (this.isAligned(yaw, pitch, epsilon)) return true
      await sleep(10)
    }

    return false
  }

  private startTrackingRotation(): void {
    this.bot.removeListener('move', this.trackSentRotation)
    this.bot.on('move', this.trackSentRotation)
    this.captureSentRotation()
  }

  private stopTrackingRotation(): void {
    this.bot.removeListener('move', this.trackSentRotation)
  }

  private getVelocity(entity: Entity): Vec3 {
    return this.localVelocityTracker.get(entity)
  }

  public shotToEntity(entity: Entity, velocity?: Vec3, weapon: RangedWeapon = this.weapon) {
    if (!velocity) velocity = this.getVelocity(entity)
    return this.aimer.compute(entity, weapon, velocity)
  }

  public hasWeapon(weapon?: string): boolean {
    weapon ??= this.weapon
    return !!this.bot.util.inv.getAllItems().find((item) => weapon && item.name.includes(weapon))
  }

  public hasAmmo(weapon?: string): boolean {
    weapon ??= this.weapon
    switch (weapon) {
      case 'bow':
        return !!this.bot.inventory.items().find((item) => item.name.includes('arrow'))
      case 'crossbow':
        return !!this.bot.inventory.items().find((item) => item.name.includes('arrow'))
      case 'crossbow_firework':
        return !!this.bot.util.inv.getAllItems().find((item) => item.name.includes('firework'))
      default:
        return !!this.bot.inventory.items().find((item) => weapon && item.name.includes(weapon))
    }
  }

  private getPreferredWeapon(): RangedWeapon | null {
    for (const weapon of RANGED_PRIORITY) {
      if (this.hasWeapon(weapon) && this.hasAmmo(weapon)) return weapon
    }
    return null
  }

  public async equipBestWeapon(): Promise<boolean> {
    const itemStr = this.getPreferredWeapon()
    if (itemStr == null) return false
    return await this.checkForWeapon(itemStr)
  }

  public async checkForWeapon(weapon?: string): Promise<boolean> {
    weapon ??= this.weapon
    const usedHand = this.bot.util.inv.getHandWithItem(this.useOffhand)
    if (!usedHand || !usedHand.name.includes(weapon)) {
      const foundItem = this.bot.util.inv.getAllItems().find((item) => item.name === weapon)
      if (!foundItem) return false
      await this.bot.util.inv.customEquip(foundItem, this.bot.util.inv.getHand(this.useOffhand))
    }
    return true
  }

  public async fireworkSetup(): Promise<boolean> {
    const weapon = this.bot.util.inv.getAllItems().find((item) => item.name.includes('crossbow'))
    if (!this.hasAmmo('crossbow_firework') || !weapon) return false
    this.useOffhand = false
    const ammo = this.bot.util.inv.getAllItems().find((item) => item.name.includes('firework'))!
    await this.bot.util.inv.customEquip(ammo, this.bot.util.inv.getHand(!this.useOffhand))
    await this.bot.util.inv.customEquip(weapon, this.bot.util.inv.getHand(this.useOffhand))
    return true
  }

  public async stop(): Promise<void> {
    this.engageRequestId++
    this.engagingTargetId = null
    this.bot.removeListener('physicsTick', this.getShotInfo)
    this.bot.removeListener('physicsTick', this.chargeHandling)
    this.stopTrackingRotation()
    if (this.target) this.bot.tracker.stopTrackingEntity(this.target)
    if (this.target) this.localVelocityTracker.clear(this.target)
    if (this.shotCharging) {
      if (this.shotInfo) await this.bot.look(this.shotInfo.yaw, this.shotInfo.pitch, true)
      this.bot.deactivateItem()
    }
    this.target = null
    this.shotCharging = false
    this.awaitingRelease = false
    this.crossbowLoading = false
    this.shotInfo = null
    this.enabled = false
  }

  public async engage(target: Entity, weapon?: RangedWeapon): Promise<void> {
    const targetId = target.id

    if (this.enabled && this.target === target) return
    if (this.engagingTargetId === targetId) return

    await this.stop()
    const requestId = ++this.engageRequestId
    this.engagingTargetId = targetId

    const selectedWeapon = weapon ?? this.getPreferredWeapon()
    if (!selectedWeapon) return

    if (selectedWeapon === 'crossbow_firework') {
      const isSetup = await this.fireworkSetup()
      if (requestId !== this.engageRequestId) return
      if (!isSetup) return
    } else {
      const hasWeapon = await this.checkForWeapon(selectedWeapon)
      if (requestId !== this.engageRequestId) return
      if (!hasWeapon) return
    }

    this.weapon = selectedWeapon
    this.enabled = true
    this.target = target
    this.engagingTargetId = null
    this.bot.tracker.trackEntity(target)
    this.bot.removeListener('physicsTick', this.getShotInfo)
    this.bot.removeListener('physicsTick', this.chargeHandling)
    this.bot.on('physicsTick', this.getShotInfo)
    this.bot.on('physicsTick', this.chargeHandling)
    this.startTrackingRotation()
  }

  public async shootAt(yaw?: number, grade?: number, weapon?: RangedWeapon) {
    if (this.shotCharging) return
    const hasWeapon = await this.checkForWeapon(weapon)
    if (!hasWeapon) await this.stop()
    if (!yaw) yaw = this.bot.player.entity.yaw
    if (!grade) grade = this.bot.player.entity.pitch
    if (weapon) this.weapon = weapon
    this.shotCharging = true
    this.shotInit = performance.now()
    this.startTrackingRotation()

    const aligned = await this.ensureLookedAt(yaw, grade)
    if (!aligned) {
      this.shotCharging = false
      this.stopTrackingRotation()
      return
    }

    this.bot.activateItem(this.useOffhand)
    while (!this.shotReady) await sleep(50)
    this.bot.deactivateItem()

    this.shotCharging = false
    this.stopTrackingRotation()
  }

  private getShotInfo = async () => {
    if (!this.enabled || !this.target) return
    this.localVelocityTracker.record(this.target, performance.now())
    this.shotInfo = this.shotToEntity(this.target, this.getVelocity(this.target))
  }

  private chargeHandling = async () => {
    if (!this.enabled || !this.target) return

    switch (this.weapon) {
      case 'bow':
      case 'trident':
        this.waitTime = 1200
        break
      case 'snowball':
      case 'egg':
      case 'splash_potion':
        this.waitTime = 150
        break
      case 'ender_pearl':
        this.waitTime = 1000
        break
      case 'crossbow':
      case 'crossbow_firework':
        const weaponHand = this.bot.util.inv.getHandWithItem(this.useOffhand)
        if (!weaponHand) return
        const isEnchanted = weaponHand.enchants.find((enchant) => enchant.name === 'quick_charge')
        this.waitTime = 1250 - (isEnchanted ? isEnchanted.lvl : 0) * 250
        break
      default:
        this.waitTime = 1200
    }

    if (!this.shotCharging) {
      if (CHARGE_WEAPONS.has(this.weapon)) {
        const currentHand = this.bot.util.inv.getHandWithItem(this.useOffhand)
        if (!currentHand || !currentHand.name.includes(this.weapon)) {
          void this.checkForWeapon(this.weapon)
          return
        }
        this.bot.activateItem(this.useOffhand)
      }
      this.shotCharging = true
      this.shotInit = performance.now()
    }

    const info = this.shotInfo
    if (!info || !info.hit) return

    void this.bot.look(info.yaw, info.pitch, true)

    if (!this.shotReady || this.awaitingRelease) return

    this.awaitingRelease = true
    try {
      const freshInfo = this.shotInfo
      if (!freshInfo?.hit || !this.shotReady || !this.enabled || !this.shotCharging) return

      await this.bot.look(freshInfo.yaw, freshInfo.pitch, true)

      if (!this.enabled || !this.shotCharging || !this.shotReady) return

      if (['bow', 'trident'].includes(this.weapon)) {
        this.bot.deactivateItem()
        this.shotCharging = false
        return
      }

      if (THROW_WEAPONS.has(this.weapon)) {
        this.bot.swingArm(undefined)
        this.bot.activateItem(this.useOffhand)
        this.bot.deactivateItem()
        this.shotCharging = false
        return
      }

      if (['crossbow_firework', 'crossbow'].includes(this.weapon)) {
        this.shootCrossbow()
      }
    } finally {
      this.awaitingRelease = false
    }
  }

  private shootCrossbow() {
    if (this.crossbowLoading) {
      this.bot.activateItem(this.useOffhand)
      this.bot.deactivateItem()
      this.crossbowLoading = false
      this.shotCharging = false
      return
    }

    if (!this.crossbowLoading && this.shotReady) {
      this.bot.deactivateItem()
      this.crossbowLoading = true
    }
  }
}
