import { promisify } from 'util';
import type { Bot } from 'mineflayer';
import type { Range } from '../config/types.js';

const sleep = promisify(setTimeout);

export function randomInRange(range: Range): number {
  return range.min + Math.random() * (range.max - range.min);
}

export function randomIntInRange(range: Range): number {
  return Math.round(randomInRange(range));
}

export function delay(ms: number): Promise<void> {
  return sleep(ms);
}

export function humanDelay(range: Range): Promise<void> {
  return sleep(randomInRange(range));
}

export async function humanTicks(bot: Bot, range: Range): Promise<void> {
  const ticks = Math.max(1, randomIntInRange(range));
  await bot.waitForTicks(ticks);
}

export function jitter(value: number, amount: number): number {
  return value + (Math.random() - 0.5) * 2 * amount;
}

export function shouldTrigger(probability: number): boolean {
  return Math.random() < probability;
}

export function weightedChoice<T>(choices: Array<{ value: T; weight: number }>): T {
  const total = choices.reduce((s, c) => s + c.weight, 0);
  let roll = Math.random() * total;
  for (const choice of choices) {
    roll -= choice.weight;
    if (roll <= 0) return choice.value;
  }
  const last = choices[choices.length - 1];
  if (!last) throw new Error('weightedChoice called with empty array');
  return last.value;
}

export function gaussianNoise(amplitude: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1 + 1e-9)) * Math.cos(2 * Math.PI * u2);
  return z * amplitude;
}

export function microSaccade(amplitude: number): { yawDelta: number; pitchDelta: number } {
  const yawDelta = gaussianNoise(amplitude);
  const pitchDelta = gaussianNoise(amplitude * 0.6);
  return { yawDelta, pitchDelta };
}

export function humanizeAngle(
  angle: number,
  correctionThreshold: number,
  correctionSpeed: number,
  noise: number,
): number {
  const rawError = angle;
  if (Math.abs(rawError) < correctionThreshold) {
    return angle + gaussianNoise(noise * 0.3);
  }
  const corrected = rawError * correctionSpeed;
  return corrected + gaussianNoise(noise);
}

export function overshootAngle(
  current: number,
  target: number,
  amplitude: number,
  recoveryFactor: number,
): { value: number; recovering: boolean } {
  const diff = target - current;
  const overshot = current + diff * (1 + amplitude);
  const corrected = overshot - (overshot - target) * (1 - recoveryFactor);
  return { value: corrected, recovering: Math.abs(overshot - target) > 0.005 };
}

export function simulatedFrameDelay(framerateRange: Range): number {
  const fps = randomInRange(framerateRange);
  return 1000 / fps;
}

export function humanizedCps(
  baseCps: number,
  varianceFactor: number,
  wristFatigue: boolean,
  wristFatigueFactor: number,
): number {
  const variance = gaussianNoise(baseCps * varianceFactor);
  const fatiguePenalty = wristFatigue ? wristFatigueFactor * baseCps * Math.random() : 0;
  return Math.max(1, baseCps + variance - fatiguePenalty);
}

export function naturalDecelerationFactor(speed: number, maxSpeed: number): number {
  return 1 - Math.pow(speed / maxSpeed, 2) * 0.3;
}

export function clickReleaseDelay(range: Range): Promise<void> {
  return sleep(randomInRange(range));
}

export function focusLapseCheck(
  frequency: number,
  durationRange: Range,
): { lapseOccurs: boolean; durationTicks: number } {
  if (!shouldTrigger(frequency)) return { lapseOccurs: false, durationTicks: 0 };
  return { lapseOccurs: true, durationTicks: randomIntInRange(durationRange) };
}

export function eyeHeightJitter(baseHeight: number, varianceFactor: number): number {
  return baseHeight + gaussianNoise(baseHeight * varianceFactor);
}

export function mouseAccelerationCurve(rawDelta: number, accelerationFactor: number): number {
  return rawDelta * (1 + Math.abs(rawDelta) * accelerationFactor);
}
