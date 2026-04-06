import { Vec3 } from 'vec3';
import { trajectoryInfo } from '../calc/constants.js';
import { yawPitchToDir } from '../calc/math.js';

export type TrajectoryPoint = {
  position: Vec3;
  velocity: Vec3;
  tick: number;
};

export type TrajectoryResult = {
  points: TrajectoryPoint[];
  totalTicks: number;
  finalPosition: Vec3;
};

export type SolvedAim = {
  yaw: number;
  pitch: number;
  flightTicks: number;
  impactPosition: Vec3;
};

export function simulateProjectile(
  origin: Vec3,
  yaw: number,
  pitch: number,
  weaponName: string,
  maxTicks = 120,
): TrajectoryResult {
  const info = trajectoryInfo[weaponName] ?? trajectoryInfo['bow'] ?? { v0: 3.0, g: 0.05, drag: 0.99 };
  const vel = yawPitchToDir(yaw, pitch, info.v0);
  const pos = origin.clone();
  const points: TrajectoryPoint[] = [];

  for (let t = 0; t < maxTicks; t++) {
    vel.y -= info.g;
    vel.x *= info.drag;
    vel.y *= info.drag;
    vel.z *= info.drag;
    pos.x += vel.x;
    pos.y += vel.y;
    pos.z += vel.z;

    const snap: TrajectoryPoint = {
      position: pos.clone(),
      velocity: vel.clone(),
      tick: t + 1,
    };
    points.push(snap);

    if (pos.y < -64) break;
  }

  return {
    points,
    totalTicks: points.length,
    finalPosition: pos.clone(),
  };
}

export function closestApproachTick(points: TrajectoryPoint[], target: Vec3): number {
  let bestTick = 0;
  let bestDist = Infinity;
  for (const pt of points) {
    const d = pt.position.distanceTo(target);
    if (d < bestDist) {
      bestDist = d;
      bestTick = pt.tick;
    }
  }
  return bestTick;
}

export function solveAimIterative(
  origin: Vec3,
  targetEntity: { position: Vec3; velocity: Vec3; height: number },
  weaponName: string,
  iterations = 8,
): SolvedAim | null {
  const info = trajectoryInfo[weaponName] ?? trajectoryInfo['bow'] ?? { v0: 3.0, g: 0.05, drag: 0.99 };
  const hitboxCenter = targetEntity.position.offset(0, targetEntity.height * 0.5, 0);

  let predictedPos = hitboxCenter.clone();

  for (let iter = 0; iter < iterations; iter++) {
    const dx = predictedPos.x - origin.x;
    const dy = predictedPos.y - origin.y;
    const dz = predictedPos.z - origin.z;
    const hDist = Math.sqrt(dx * dx + dz * dz);
    const yaw = Math.atan2(dx, dz) + Math.PI;

    const pitch = solvePitch(hDist, dy, info.v0, info.g, info.drag);
    if (pitch === null) return null;

    const result = simulateProjectile(origin, yaw, pitch, weaponName, 200);
    const closestTick = closestApproachTick(result.points, predictedPos);

    const targetVel = targetEntity.velocity;
    predictedPos = targetEntity.position
      .offset(0, targetEntity.height * 0.5, 0)
      .offset(targetVel.x * closestTick, targetVel.y * closestTick, targetVel.z * closestTick);

    const pt = result.points[closestTick - 1];
    if (pt && pt.position.distanceTo(predictedPos) < 0.5) {
      return {
        yaw,
        pitch,
        flightTicks: closestTick,
        impactPosition: pt.position.clone(),
      };
    }
  }

  const dx = predictedPos.x - origin.x;
  const dy = predictedPos.y - origin.y;
  const dz = predictedPos.z - origin.z;
  const hDist = Math.sqrt(dx * dx + dz * dz);
  const yaw = Math.atan2(dx, dz) + Math.PI;
  const pitch = solvePitch(hDist, dy, info.v0, info.g, info.drag);
  if (pitch === null) return null;

  const result = simulateProjectile(origin, yaw, pitch, weaponName, 200);
  const closestTick = closestApproachTick(result.points, predictedPos);
  const pt = result.points[closestTick - 1];

  return {
    yaw,
    pitch,
    flightTicks: closestTick,
    impactPosition: pt?.position.clone() ?? predictedPos,
  };
}

function solvePitch(hDist: number, vDist: number, v0: number, gravity: number, drag: number): number | null {
  if (hDist < 0.001) return Math.PI / 2;

  const g = gravity;
  const d = drag;

  const effectiveDrag = d < 1 ? (1 - Math.pow(d, 20)) / (1 - d) : 20;
  const horizFactor = (Math.pow(d, 1) * effectiveDrag) / 20;
  if (horizFactor <= 0) return null;

  for (let pitch = -Math.PI / 2; pitch <= Math.PI / 2; pitch += Math.PI / 360) {
    const sim = simulateProjectile(new Vec3(0, 0, 0), 0, pitch, 'bow', 200);
    for (const pt of sim.points) {
      const simH = Math.sqrt(pt.position.x * pt.position.x + pt.position.z * pt.position.z);
      if (Math.abs(simH - hDist) < 0.3 && Math.abs(pt.position.y - vDist) < 0.5) {
        return pitch;
      }
    }
  }

  const discriminant = v0 * v0 * v0 * v0 - g * (g * hDist * hDist + 2 * vDist * v0 * v0);

  if (discriminant < 0) return null;

  const pitch1 = Math.atan((v0 * v0 - Math.sqrt(discriminant)) / (g * hDist));
  const pitch2 = Math.atan((v0 * v0 + Math.sqrt(discriminant)) / (g * hDist));

  if (!isNaN(pitch1) && pitch1 >= -Math.PI / 2 && pitch1 <= Math.PI / 2) return pitch1;
  if (!isNaN(pitch2) && pitch2 >= -Math.PI / 2 && pitch2 <= Math.PI / 2) return pitch2;
  return null;
}

export function estimatePearlLandingPosition(origin: Vec3, yaw: number, pitch: number): Vec3 {
  const result = simulateProjectile(origin, yaw, pitch, 'ender_pearl', 80);
  return result.finalPosition;
}
