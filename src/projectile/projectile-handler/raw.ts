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

  constructor(
    private bot: Bot,
    bowConfig?: BowConfig,
    _fireballConfig?: FireballConfig,
  ) {
    const resolvedBowConfig: BowConfig = bowConfig ?? {
      enabled: true,
      preferOverFireball: true,
      aimBackend: 'shot-planner',
      leadIterations: 8,
      bridgeKnockbackEnabled: true,
    }

    this.aimer = createProjectileAimBackend(bot, resolvedBowConfig)
    this.trackSentRotation = this.captureSentRotation.bind(this)
    this.captureSentRotation()

    this.bot.on('entityGone', (e) => {
      if (e === this.target) void this.stop()
    })
    // this.intercepter = new InterceptEquations(bot);
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
    return this.bot.tracker.getEntitySpeed(entity) || new Vec3(0, 0, 0)
  }

  /**
   *
   * @param entity
   * @param velocity
   * @returns
   */
  public shotToEntity(entity: Entity, velocity?: Vec3, weapon: RangedWeapon = this.weapon) {
    if (!velocity) velocity = this.getVelocity(entity)
    return this.aimer.compute(entity, weapon, velocity)
  }

  /**
   * @function hasWeapon
   * @param {string} weapon
   * @returns
   */
  public hasWeapon(weapon?: string): boolean {
    weapon ??= this.weapon
    return !!this.bot.util.inv.getAllItems().find((item) => weapon && item.name.includes(weapon))
  }

  /**
   * @function hasAmmo
   * @param   {string} [weapon=this.weapon] Optional string name of a weapon. Defaults to this.weapon.
   * @returns {boolean} If the weapon has ammo or not.
   *
   * ### Usage:
   * ```ts
   * // Let us fire!
   * let doWeHaveAmmo = bot.bowpvp.hasAmmo();
   * if (doWeHaveAmmo) {
   * ‍    console.log("cool.")
   * } else {
   * ‍    ocnsole.log("not cool.")
   * }
   * ```
   */
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

  /**
     * @function checkForWeapon
     * Checks to see if a weapon exists
     * @param {string} weapon A string name of a weapon to check for
     * @returns {Promise<boolean>} A promise with a boolean
     * 
     * ### Usage:
     * ```ts
        // Check for our weapon
        let doWeHaveABow = await bot.bowpvp.checkForWeapon("bow");
        if (doWeHaveABow) {
        ‍    console.log("We have a bow.")
        } else {
        ‍    console.log("God damnit")
        }
        ```
     */
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
    // if (!this.bot.util.inv.getHandWithItem(true)?.name.includes("firework")) {
    const ammo = this.bot.util.inv.getAllItems().find((item) => item.name.includes('firework'))!
    await this.bot.util.inv.customEquip(ammo, this.bot.util.inv.getHand(!this.useOffhand))
    await this.bot.util.inv.customEquip(weapon, this.bot.util.inv.getHand(this.useOffhand))
    return true
    // }
  }

  /**
   * @function stop
   * @public
   *
   * ### Usage:
   * ```ts
   * // Stop with the bow!
   * bot.bowpvp.stop()
   * // That's better
   * ```
   */
  public async stop(): Promise<void> {
    this.engageRequestId++
    this.engagingTargetId = null
    this.bot.removeListener('physicsTick', this.getShotInfo)
    this.bot.removeListener('physicsTick', this.chargeHandling)
    this.stopTrackingRotation()
    if (this.target) this.bot.tracker.stopTrackingEntity(this.target)
    if (this.shotCharging) {
      // if (this.shotInfo) this.bot.look(this.shotInfo.yaw, this.shotInfo.pitch, true);
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

  /**
   * Attacks a specified target with a specified weapon.
   * @function engage
   * @public
   * @param   {Entity} target An Entity object.
   * @param   {string} [weapon=this.weapon] An optional string name of an item featured in the bots inventory.
   * @return  {Promise<void>} An empty promise
   *
   * ### Usage:
   * ```ts
   * // Get our target
   * target = bot.nearestEntity((e) => (e.username ?? e.name) === "test_player");
   * // Start the attack!
   * bot.newbowpvp.engage(target, "bow");
   * ```
   */
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

  /**
   *
   * @param yaw
   * @param grade
   * @param weapon
   * @returns
   */
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
        if (!weaponHand) return console.log('cant find a thing')
        const isEnchanted = weaponHand.enchants.find((enchant) => enchant.name === 'quick_charge')
        this.waitTime = 1250 - (isEnchanted ? isEnchanted.lvl : 0) * 250
        break
      default:
        this.waitTime = 1200
    }

    if (!this.shotCharging) {
      if (CHARGE_WEAPONS.has(this.weapon)) {
        this.bot.activateItem(this.useOffhand)
      }
      this.shotCharging = true
      this.shotInit = performance.now()
    }

    if (!this.shotInfo || !this.shotInfo.hit) return
    if (!this.shotReady || this.awaitingRelease) return

    this.awaitingRelease = true
    try {
      const aligned = await this.ensureLookedAt(this.shotInfo.yaw, this.shotInfo.pitch)
      if (!aligned || !this.shotReady) return

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
    // console.log(this.crossbowLoading, this.shotReady, performance.now() - this.shotInit)
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
