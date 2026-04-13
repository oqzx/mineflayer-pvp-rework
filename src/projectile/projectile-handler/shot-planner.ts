import type { Bot } from 'mineflayer'
import {
  type AABBComponents,
  type BasicShotInfo,
  ShotFactory,
  InterceptFunctions,
} from '@nxg-org/mineflayer-trajectories'
import { getTargetYaw } from '../../calc/math'
import { trajectoryInfo } from '../../calc/constants'
import { Vec3 } from 'vec3'
import { AABBUtils } from '@nxg-org/mineflayer-util-plugin'
import type { Entity } from 'prismarine-entity'
import type { CurvaturePrediction } from '@nxg-org/mineflayer-tracker'
import type { ProjectilePredictionProvider } from './aim-backend.js'

const dv = Math.PI / 360
const PIOver2 = Math.PI / 2
const PIOver3 = Math.PI / 3

type pitchAndTicks = { pitch: number; ticks: number }
type CheckShotInfo = { yaw: number; pitch: number; ticks: number; shift?: boolean }
export type CheckedShot = {
  hit: boolean
  yaw: number
  pitch: number
  ticks: number
  confidence: number
  shotInfo: BasicShotInfo | null
}

type MovementSnapshot = {
  previous: Vec3 | null
  current: Vec3
}

export class ShotPlanner {
  public weapon: string = 'bow'
  private intercepter: InterceptFunctions
  private readonly recentMovement = new Map<number, MovementSnapshot>()
  private readonly lastLoggedPredictionTick = new Map<number, number>()
  constructor(private bot: Bot) {
    this.intercepter = new InterceptFunctions(bot)
    this.bot.on('entityMoved', this.trackEntityMovement)
  }

  private readonly trackEntityMovement = (entity: Entity): void => {
    const current = entity.position.clone()
    const snapshot = this.recentMovement.get(entity.id)
    this.recentMovement.set(entity.id, {
      previous: snapshot?.current ?? null,
      current,
    })
  }

  private getLaunchSpeed(): number {
    return trajectoryInfo[this.weapon]?.v0 ?? 3
  }

  private getCompensatedYaw(targetPos: Vec3): number {
    const botPos = this.bot.entity.position
    const directYaw = getTargetYaw(botPos, targetPos)
    const deltaX = targetPos.x - botPos.x
    const deltaZ = targetPos.z - botPos.z
    const horizontalDistance = Math.hypot(deltaX, deltaZ)
    if (horizontalDistance === 0) return directYaw

    const targetDirX = deltaX / horizontalDistance
    const targetDirZ = deltaZ / horizontalDistance
    const originVelX = this.bot.entity.velocity.x
    const originVelZ = this.bot.entity.velocity.z
    const dot = targetDirX * originVelX + targetDirZ * originVelZ
    const originHorizontalSpeedSq = originVelX * originVelX + originVelZ * originVelZ
    const launchSpeed = this.getLaunchSpeed()
    const discriminant = dot * dot + launchSpeed * launchSpeed - originHorizontalSpeedSq
    if (discriminant <= 0) return directYaw

    const alignedSpeed = dot + Math.sqrt(discriminant)
    const aimX = alignedSpeed * targetDirX - originVelX
    const aimZ = alignedSpeed * targetDirZ - originVelZ
    if (aimX === 0 && aimZ === 0) return directYaw

    return getTargetYaw(new Vec3(0, 0, 0), new Vec3(aimX, 0, aimZ))
  }

  private getYawDegrees(yaw: number): string {
    return ((yaw * 180) / Math.PI).toFixed(1)
  }

  private getRelativeMovementSummary(targetPos: Vec3, movementDelta: Vec3 | null): string {
    if (!movementDelta) return 'null'

    const toTarget = targetPos.minus(this.bot.entity.position)
    const planarDistance = Math.hypot(toTarget.x, toTarget.z)
    const movementMagnitude = Math.hypot(movementDelta.x, movementDelta.z)
    if (planarDistance === 0 || movementMagnitude === 0) {
      return `move=(${movementDelta.x.toFixed(3)}, ${movementDelta.z.toFixed(3)}) radial=0.000 tangential=0.000 angleDeg=0.0`
    }

    const radialX = toTarget.x / planarDistance
    const radialZ = toTarget.z / planarDistance
    const tangentX = -radialZ
    const tangentZ = radialX
    const radial = movementDelta.x * radialX + movementDelta.z * radialZ
    const tangential = movementDelta.x * tangentX + movementDelta.z * tangentZ
    const cosine = Math.max(
      -1,
      Math.min(1, radial / movementMagnitude),
    )
    const angleDeg = (Math.acos(cosine) * 180) / Math.PI

    return (
      `move=(${movementDelta.x.toFixed(3)}, ${movementDelta.z.toFixed(3)}) ` +
      `radial=${radial.toFixed(3)} tangential=${tangential.toFixed(3)} angleDeg=${angleDeg.toFixed(1)}`
    )
  }



  private isShotValid(shotInfo1: CheckedShot | BasicShotInfo, target: Vec3, pitch: number) {
    let shotInfo = (shotInfo1 as CheckedShot).shotInfo
    if (!shotInfo) shotInfo = shotInfo1 as BasicShotInfo
    //@ts-expect-error type coercion to CheckedShot.
    if (shotInfo.shotInfo) shotInfo = shotInfo.shotInfo as BasicShotInfo
    if (!shotInfo) return false
    if (shotInfo.blockingBlock && pitch > PIOver3) {
      return shotInfo.blockingBlock.position.y <= target.y - 1
    } else {
      return shotInfo.intersectPos && !shotInfo.blockingBlock
    }
  }

  /**
   * Better optimization. Still about 5x more expensive than hawkeye (no clue what I did) but its more accurate so whatever.
   *
   * Note: The increased cost comes from the increased checks made (1440 vs 100). This will be fixed.
   *
   * @param target
   * @param pitch
   * @returns {CheckedShot} the shot.
   */
  shotToEntity(
    target: Entity,
    pitch: number = -PIOver2,
    predictionProvider?: ProjectilePredictionProvider,
  ): CheckedShot | null {
    const yaw = this.getCompensatedYaw(target.position)
    while (pitch < PIOver2) {
      const initInfo = this.getNextShot(target, yaw, pitch)
      pitch = initInfo.pitch
      const newInfo = this.shiftTargetPositions(target, predictionProvider, initInfo)
      for (const i of newInfo) {
        const correctShot = this.checkForBlockIntercepts(i.target, ...i.info)
        if (!correctShot.shotInfo) continue
        correctShot.confidence = i.confidence
        if (this.isShotValid(correctShot, i.target.position, pitch)) return correctShot
        const yawShot = this.getAlternativeYawShots(i.target, initInfo)
        yawShot.confidence = i.confidence
        if (this.isShotValid(yawShot, i.target.position, pitch)) return yawShot
      }
    }
    return null
  }

  private shiftTargetPositions(
    target: Entity,
    predictionProvider?: ProjectilePredictionProvider,
    ...shotInfo: CheckShotInfo[]
  ) {
    const tickoffset = 0
    const newInfo: { position: Vec3; confidence: number }[] = shotInfo.map((i, index) => {
      const ticks = i.ticks + tickoffset
      if (index === 0) this.bot.tracker.debugReplayLogging = true
      else this.bot.tracker.debugReplayLogging = false
      // this.bot.tracker.debugReplayLogging = false
      const predict =
        predictionProvider?.(target, ticks) ??
        this.bot.tracker.predictEntityPositionWithConfidence(target, ticks)
      const startTick = (this.bot as any).currentTick
      if (index === 0) {
        this.bot.tracker.logActualTargetPositionAfterTicks(target, ticks, predict, startTick)
      }
      if (predict) return { position: predict.position.clone(), confidence: predict.confidence }
      return { position: target.position.clone(), confidence: 0 }
    })

    const allInfo: { target: AABBComponents; info: CheckShotInfo[]; confidence: number }[] = []
    for (const itemInfo of newInfo) {
      const position = itemInfo.position
      const yaw = this.getCompensatedYaw(position)
      const item: AABBComponents = { position, height: target.height }
      if (target.width) item.width = target.width

      const res = this.getAllPossibleShots(item, yaw)
      const info = res.map((i) => {
        return { yaw, pitch: i.pitch, ticks: i.ticks }
      })
      allInfo.push({ target: item, info, confidence: itemInfo.confidence })
    }
    return allInfo
  }

  public checkForBlockIntercepts(target: AABBComponents, ...shots: CheckShotInfo[]): CheckedShot {
    for (const { pitch, ticks, yaw } of shots) {
      const initShot = ShotFactory.fromPlayer(
        {
          position: this.bot.entity.position,
          yaw,
          pitch,
          velocity: this.bot.entity.velocity,
          onGround: this.bot.entity.onGround,
        },
        this.intercepter,
        this.weapon,
      )
      const shot = initShot.hitsEntity(target, { yawChecked: false, blockCheck: true })?.shotInfo
      if (!!shot && this.isShotValid(shot, target.position, Number(pitch)))
        return { hit: true, yaw, pitch: Number(pitch), ticks, confidence: 0, shotInfo: shot }
    }
    return { hit: false, yaw: NaN, pitch: NaN, ticks: NaN, confidence: 0, shotInfo: null }
  }

  public getNextShot(
    target: AABBComponents,
    yaw: number,
    minPitch: number = -PIOver2,
  ): CheckShotInfo {
    let shift: boolean = true
    const hittingData: pitchAndTicks[] = []

    for (let pitch = minPitch + dv; pitch < PIOver2; pitch += dv) {
      if (pitch > PIOver3) shift = true
      const initShot = ShotFactory.fromPlayer(
        {
          position: this.bot.entity.position,
          yaw,
          pitch,
          velocity: this.bot.entity.velocity,
          onGround: this.bot.entity.onGround,
        },
        this.intercepter,
        this.weapon,
      )
      const shot = initShot.hitsEntity(target, { yawChecked: false, blockCheck: false })?.shotInfo
      if (!shot) continue
      if (!shot.intersectPos) {
        if (hittingData.length !== 0) {
          const pitch = hittingData.map((e) => e.pitch).reduce((a, b) => a + b) / hittingData.length //monkeypatch to hit feet.
          const ticks = Math.round(
            hittingData.map((e) => e.ticks).reduce((a, b) => a + b) / hittingData.length,
          )
          return { yaw, pitch, ticks, shift }
        } else if (pitch > PIOver3 && shot.nearestDistance < 1) {
          hittingData.push({ pitch, ticks: shot.totalTicks })
        }
        continue
      }
      hittingData.push({ pitch, ticks: shot.totalTicks })
    }
    return { yaw: NaN, pitch: NaN, ticks: NaN }
  }

  public getAlternativeYawShots(target: AABBComponents, ...shots: CheckShotInfo[]): CheckedShot {
    for (const { pitch, yaw: orgYaw } of shots) {
      const yaws = AABBUtils.getEntityAABBRaw(target)
        .toVertices()
        .map((p) => getTargetYaw(this.bot.entity.position, p))
        .sort((a, b) => orgYaw - Math.abs(a) - (orgYaw - Math.abs(b)))
      let inbetween = [yaws.pop()!, yaws.pop()!]
      inbetween = inbetween.map((y) => y + Math.sign(orgYaw - y) * 0.02)
      for (const yaw of inbetween) {
        const initShot = ShotFactory.fromShootingPlayer(
          {
            position: this.bot.entity.position,
            yaw,
            pitch,
            velocity: this.bot.entity.velocity,
            onGround: this.bot.entity.onGround,
          },
          this.intercepter,
          this.weapon,
        )
        const shot = initShot.hitsEntity(target, { yawChecked: false, blockCheck: true })?.shotInfo
        if (!!shot && (shot.intersectPos || (pitch > PIOver3 && shot.nearestDistance < 1))) {
          return { hit: true, yaw, pitch, ticks: shot.totalTicks, confidence: 0, shotInfo: shot }
        }
      }
    }
    return { hit: false, yaw: NaN, pitch: NaN, ticks: NaN, confidence: 0, shotInfo: null }
  }

  //TODO: This is too expensive. Will aim at offset off foot instead of calc'ing all hits and averaging.
  public getAllPossibleShots(target: AABBComponents, yaw: number) {
    const possibleShotData: CheckShotInfo[] = []
    let shift: boolean = true
    let hittingData: pitchAndTicks[] = []

    for (let pitch = -PIOver2; pitch < PIOver2; pitch += dv) {
      if (pitch > PIOver3) shift = true
      const initShot = ShotFactory.fromPlayer(
        {
          position: this.bot.entity.position,
          yaw,
          pitch,
          velocity: this.bot.entity.velocity,
          onGround: this.bot.entity.onGround,
        },
        this.intercepter,
        this.weapon,
      )
      const shot = initShot.hitsEntity(target, { yawChecked: false, blockCheck: false })?.shotInfo
      if (!shot) continue
      if (!shot.intersectPos) {
        if (hittingData.length !== 0) {
          const pitch = hittingData.map((e) => e.pitch).reduce((a, b) => a + b) / hittingData.length //monkeypatch to hit feet.
          const ticks = Math.round(
            hittingData.map((e) => e.ticks).reduce((a, b) => a + b) / hittingData.length,
          )
          possibleShotData.push({ yaw, pitch, ticks, shift })
          hittingData = []
        } else if (pitch > PIOver3 && shot.nearestDistance < 1) {
          hittingData.push({ pitch, ticks: shot.totalTicks })
        }
        continue
      }
      hittingData.push({ pitch, ticks: shot.totalTicks })
    }
    return possibleShotData
  }
}
