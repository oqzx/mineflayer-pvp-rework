import { performance } from 'perf_hooks'
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { BowConfig, FireballConfig } from '../config/types.js'
import { BowAiming } from './bow-aiming.js'
import type { AimResult } from './bow-aiming.js'

const CHARGE_WEAPONS = new Set(['bow', 'crossbow', 'trident'])
const THROW_WEAPONS = new Set(['snowball', 'ender_pearl', 'egg', 'splash_potion'])

type RangedWeapon =
  | 'bow'
  | 'crossbow'
  | 'crossbow_firework'
  | 'trident'
  | 'snowball'
  | 'ender_pearl'
  | 'egg'
  | 'splash_potion'
  | 'fireball'
  | 'none'

function detectBestWeapon(bot: Bot, preferBow: boolean): RangedWeapon {
  const inv = bot.util.inv.getAllItems()
  const hasBow = inv.some((i) => i.name === 'bow')
  const hasArrows = inv.some((i) => i.name.includes('arrow'))
  const hasCrossbow = inv.some((i) => i.name === 'crossbow')
  const hasFireball = inv.some((i) => i.name.includes('fire_charge'))

  if (preferBow && hasBow && hasArrows) return 'bow'
  if (hasCrossbow && hasArrows) return 'crossbow'
  if (!preferBow && hasFireball) return 'fireball'
  if (hasBow && hasArrows) return 'bow'
  return 'none'
}

function getChargeTime(weapon: RangedWeapon, bot: Bot): number {
  switch (weapon) {
    case 'bow':
    case 'trident':
      return 1200
    case 'crossbow': {
      const item = bot.util.inv.getHandWithItem(false)
      const qc = item?.enchants.find((e) => e.name === 'quick_charge')
      return 1250 - (qc ? qc.lvl * 250 : 0)
    }
    case 'snowball':
    case 'ender_pearl':
    case 'splash_potion':
      return 150
    default:
      return 1200
  }
}

export class ProjectileHandler {
  private active: boolean = false
  private target: Entity | null = null
  private weapon: RangedWeapon = 'none'
  private charging: boolean = false
  private chargeStart: number = 0
  private crossbowLoaded: boolean = false
  private useOffhand: boolean = false
  private shotInfo: AimResult | null = null

  private readonly aiming: BowAiming
  private readonly getShotTick: () => void
  private readonly chargeAndFire: () => void

  constructor(
    private readonly bot: Bot,
    private readonly bowConfig: BowConfig,
    private readonly fireballConfig: FireballConfig,
  ) {
    this.aiming = new BowAiming(bowConfig)
    this.getShotTick = this.computeShotInfo.bind(this)
    this.chargeAndFire = this.chargeHandling.bind(this)
  }

  get isActive(): boolean {
    return this.active
  }

  async engage(target: Entity): Promise<void> {
    if (this.target === target) return
    this.stop()

    this.weapon = detectBestWeapon(this.bot, this.bowConfig.preferOverFireball)
    if (this.weapon === 'none') return

    const equipped = await this.equipWeapon()
    if (!equipped) return

    this.active = true
    this.target = target
    this.bot.tracker.trackEntity(target)
    this.bot.on('physicsTick', this.getShotTick)
    this.bot.on('physicsTick', this.chargeAndFire)
  }

  stop(): void {
    this.bot.removeListener('physicsTick', this.getShotTick)
    this.bot.removeListener('physicsTick', this.chargeAndFire)
    if (this.target) this.bot.tracker.stopTrackingEntity(this.target)
    if (this.charging) {
      if (this.shotInfo) void this.bot.look(this.shotInfo.yaw, this.shotInfo.pitch, true)
      this.bot.deactivateItem()
    }
    this.target = null
    this.active = false
    this.charging = false
    this.crossbowLoaded = false
    this.shotInfo = null
  }

  private computeShotInfo(): void {
    if (!this.target || !this.active) return
    this.shotInfo = this.aiming.compute(
      this.bot,
      this.target,
      this.weapon === 'fireball' ? 'bow' : this.weapon,
    )
  }

  private chargeHandling(): void {
    if (!this.target || !this.active) return

    const chargeTime = getChargeTime(this.weapon, this.bot)

    if (!this.charging) {
      if (CHARGE_WEAPONS.has(this.weapon)) {
        this.bot.activateItem(this.useOffhand)
      }
      this.charging = true
      this.chargeStart = performance.now()
    }

    if (!this.shotInfo) return

    void this.bot.look(this.shotInfo.yaw, this.shotInfo.pitch, true)

    const elapsed = performance.now() - this.chargeStart
    if (elapsed < chargeTime) return

    this.release()
  }

  private release(): void {
    if (THROW_WEAPONS.has(this.weapon)) {
      this.bot.swingArm(undefined)
      this.bot.activateItem(this.useOffhand)
      this.bot.deactivateItem()
      this.charging = false
      this.chargeStart = performance.now()
      return
    }

    if (this.weapon === 'crossbow' || this.weapon === 'crossbow_firework') {
      this.releaseCrossbow()
      return
    }

    this.bot.deactivateItem()
    this.charging = false
    this.chargeStart = performance.now()
  }

  private releaseCrossbow(): void {
    if (this.crossbowLoaded) {
      this.bot.activateItem(this.useOffhand)
      this.bot.deactivateItem()
      this.crossbowLoaded = false
      this.charging = false
      this.chargeStart = performance.now()
    } else {
      this.bot.deactivateItem()
      this.crossbowLoaded = true
    }
  }

  private async equipWeapon(): Promise<boolean> {
    if (this.weapon === 'none') return false
    const item = this.bot.util.inv.getAllItems().find((i) => i.name.includes(this.weapon))
    if (!item) return false
    await this.bot.util.inv.customEquip(item, 'hand')
    return true
  }
}
