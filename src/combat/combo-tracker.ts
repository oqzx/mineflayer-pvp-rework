import type { Range } from '../config/types.js'
import { randomIntInRange } from '../util/humanizer.js'

export type ComboState = 'neutral' | 'combo' | 'taking-damage'

export class ComboTracker {
  public state: ComboState = 'neutral'

  private hitsSinceWTap: number = 0
  private hitsSinceBlockHit: number = 0
  private nextWTapAt: number
  private nextBlockHitAt: number

  constructor(
    private readonly wTapEveryHits: Range,
    private readonly blockHitEveryHits: Range,
  ) {
    this.nextWTapAt = randomIntInRange(wTapEveryHits)
    this.nextBlockHitAt = randomIntInRange(blockHitEveryHits)
  }

  update(ticksSinceHurt: number, ticksSinceTargetHit: number): void {
    if (ticksSinceHurt <= 10) this.state = 'taking-damage'
    else if (ticksSinceTargetHit <= 20) this.state = 'combo'
    else this.state = 'neutral'
  }

  recordHit(): void {
    this.hitsSinceWTap++
    this.hitsSinceBlockHit++
  }

  shouldWTap(): boolean {
    if (this.hitsSinceWTap < this.nextWTapAt) return false
    this.hitsSinceWTap = 0
    this.nextWTapAt = randomIntInRange(this.wTapEveryHits)
    return true
  }

  shouldBlockHit(): boolean {
    if (this.hitsSinceBlockHit < this.nextBlockHitAt) return false
    this.hitsSinceBlockHit = 0
    this.nextBlockHitAt = randomIntInRange(this.blockHitEveryHits)
    return true
  }

  reset(): void {
    this.state = 'neutral'
    this.hitsSinceWTap = 0
    this.hitsSinceBlockHit = 0
  }
}
