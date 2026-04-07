import { AABBUtils } from "@nxg-org/mineflayer-util-plugin";
import { Bot, ControlState } from "mineflayer";
import { Entity } from "prismarine-entity";
import { Item } from "prismarine-item";
import { EventEmitter } from "stream";
import { Vec3 } from "vec3";
import { getTargetYaw, lookingAt, movingAt } from "../calc/math";
import { attack } from "../util";
import { defaultConfig, FullConfig, getConfig } from "./swordconfigs";
import { MaxDamageOffset, NewPVPTicks, OldPVPTicks } from "./swordutil";
import { followEntity, stopFollow } from "./swordutil";

const { getEntityAABB } = AABBUtils;
const PIOver3 = Math.PI / 3;

type ComboState = "neutral" | "combo" | "taking-damage";

export class SwordPvp extends EventEmitter {
  public ticksToNextAttack: number = 0;
  public ticksSinceTargetAttack: number = 0;
  public ticksSinceLastHurt: number = 0;
  public ticksSinceLastTargetHit: number = 0;
  public ticksSinceLastSwitch: number = 0;
  public ticksSinceLastTargetHurt: number = 999;
  public wasInRange: boolean = false;
  public wasVisible: boolean = false;
  public comboState: ComboState = "neutral";
  public meleeAttackRate: MaxDamageOffset;
  public target?: Entity;
  public lastTarget?: Entity;
  public weaponOfChoice: string = "sword";

  private willBeFirstHit: boolean = true;
  private tickOverride: boolean = false;
  private targetShielding: boolean = false;
  private shieldToggleListener?: (entity: Entity, reason: string, ticks: number) => void;
  private currentStrafeDir?: ControlState;
  private strafeCounter: number = 0;
  private targetGoal?: any;
  private blockHitActive: boolean = false;
  private consecutiveWallHitTicks: number = 0;
  private previousBotPosition: Vec3 = new Vec3(0, 0, 0);
  private targetVelocityHistory: Vec3[] = [];
  private lastHealth: number = 20;

  constructor(public bot: Bot, public options: FullConfig = getConfig(bot)) {
    super();
    this.meleeAttackRate = bot.supportFeature("doesntHaveOffHandSlot")
      ? new OldPVPTicks(bot, options.cps ?? 15)
      : new NewPVPTicks(bot);

    this.bot.on("physicsTick", this.update);
    this.bot.on("physicsTick", this.checkForShield);
    this.bot.on("entitySwingArm", this.swingUpdate);
    this.bot.on("entityUpdate", this.hurtUpdate);
    this.bot.on("entityHurt", this.targetHurtUpdate);
    this.bot.on("entityDead", this.removalUpdate);
    this.bot.on("entityGone", this.removalUpdate);
  }

  changeWeaponState(weapon: string): Item | null {
    const hasWeapon = this.checkForWeapon(weapon);
    if (hasWeapon) {
      this.weaponOfChoice = weapon;
      return hasWeapon;
    }
    return null;
  }

  checkForWeapon(weapon?: string): Item | null {
    if (!weapon) weapon = this.weaponOfChoice;
    const heldItem = this.bot.inventory.slots[this.bot.getEquipmentDestSlot("hand")];
    if (heldItem?.name.includes(weapon)) return heldItem;
    const item = this.bot.util.inv.getAllItems().find((i) => i?.name.includes(weapon!));
    return item ?? null;
  }

  async equipWeapon(weapon: Item): Promise<boolean> {
    const heldItem = this.bot.inventory.slots[this.bot.getEquipmentDestSlot("hand")];
    return heldItem?.name === weapon.name ? true : await this.bot.util.inv.customEquip(weapon, "hand");
  }

  entityWeapon(entity?: Entity): Item {
    return (entity ?? this.bot.entity)?.heldItem;
  }

  entityShieldStatus(entity?: Entity): boolean {
    entity = entity ?? this.bot.entity;
    const shieldSlot = entity.equipment[1];
    return shieldSlot?.name === "shield" && this.bot.util.entity.isOffHandActive(entity);
  }

  checkForShield = async () => {
    if (!this.target) return;
    if (!this.options.shieldDisableConfig.enabled) return;
    if (this.bot.supportFeature("doesntHaveOffHandSlot")) return;

    if ((this.target.metadata[8] as any) === 3 && this.target.equipment[1]?.name === "shield") {
      if (!this.targetShielding) this.ticksSinceLastSwitch = 0;
      this.targetShielding = true;
      if (this.ticksSinceTargetAttack >= 3 && this.ticksSinceLastSwitch >= 3 && !this.tickOverride) {
        const itemToChangeTo = await this.checkForWeapon("_axe");
        if (itemToChangeTo) {
          const switched = await this.equipWeapon(itemToChangeTo);
          if (switched) {
            this.weaponOfChoice = "_axe";
            this.tickOverride = true;
            switch (this.options.shieldDisableConfig.mode) {
              case "single":
              case "double":
                this.tickOverride = true;
                await this.bot.waitForTicks(3);
                await this.attemptAttack("disableshield");
                if (this.options.shieldDisableConfig.mode === "single") break;
                await this.bot.waitForTicks(3);
                await this.attemptAttack("doubledisableshield");
            }
            this.tickOverride = false;
          }
        }
      }
    } else {
      if (this.targetShielding) this.ticksSinceLastSwitch = 0;
      this.targetShielding = false;
      if (this.weaponOfChoice === "sword" || this.tickOverride) return;
      const itemToChangeTo = await this.checkForWeapon("sword");
      if (itemToChangeTo) {
        const switched = await this.equipWeapon(itemToChangeTo);
        if (switched) {
          this.weaponOfChoice = "sword";
          this.ticksToNextAttack = this.meleeAttackRate.getTicks(this.bot.heldItem!);
        }
      }
    }
  };

  swingUpdate = async (entity: Entity) => {
    if (entity === this.target) this.ticksSinceTargetAttack = 0;
  };

  removalUpdate = async (entity: Entity) => {
    if (this.target == null) return;
    if (entity.id === this.target.id) this.stop();
  };

  targetHurtUpdate = (entity: Entity) => {
    if (!this.target) return;
    if (entity.id === this.target.id) {
      this.ticksSinceLastTargetHurt = 0;
    }
  };

  private clearShieldToggleListener() {
    if (!this.shieldToggleListener) return;
    this.off("attackedTarget", this.shieldToggleListener);
    delete this.shieldToggleListener;
  }

  hurtUpdate = async (entity: Entity) => {
    if (!this.target) return;
    if (entity !== this.bot.entity) return;
    if (this.lastHealth <= (this.bot.health ?? 20)) {
      this.lastHealth = this.bot.health;
      return;
    }
    this.lastHealth = this.bot.health;
    this.ticksSinceLastHurt = 0;

    if (this.ticksSinceTargetAttack < 6) this.ticksSinceLastTargetHit = 0;

    if (this.options.onHitConfig.kbCancel.enabled) {
      switch (this.options.onHitConfig.kbCancel.mode) {
        case "velocity":
          await new Promise<void>((resolve) => {
            const listener = (packet: any) => {
              const ent = this.bot.entities[packet.entityId];
              if (ent !== this.bot.entity) return;
              if (this.options.onHitConfig.kbCancel.mode !== "velocity") return;
              if ((this.options.onHitConfig.kbCancel as any).hRatio != null) {
                this.bot.entity.velocity.x *= (this.options.onHitConfig.kbCancel as any).hRatio;
                this.bot.entity.velocity.z *= (this.options.onHitConfig.kbCancel as any).hRatio;
              }
              if ((this.options.onHitConfig.kbCancel as any).yRatio != null)
                this.bot.entity.velocity.y *= (this.options.onHitConfig.kbCancel as any).yRatio;
              this.bot._client.removeListener("entity_velocity", listener);
              resolve();
            };
            setTimeout(() => {
              this.bot._client.removeListener("entity_velocity", listener);
              resolve();
            }, 500);
            this.bot._client.on("entity_velocity", listener);
          });
          return;

        case "jump":
        case "jumpshift":
          if (lookingAt(entity, this.target!, this.options.genericConfig.enemyReach)) {
            this.bot.setControlState("right", false);
            this.bot.setControlState("left", false);
            this.bot.setControlState("back", false);
            this.bot.setControlState("sneak", false);
            this.bot.setControlState("forward", true);
            this.bot.setControlState("sprint", true);
            this.bot.setControlState("jump", true);
            this.bot.setControlState("jump", false);
          }
          if (this.options.onHitConfig.kbCancel.mode === "jump") break;
        case "shift":
          if (lookingAt(entity, this.target!, this.options.genericConfig.enemyReach)) {
            this.bot.setControlState("sneak", true);
            await this.bot.waitForTicks((this.options.onHitConfig.kbCancel as any).delay || 5);
            this.bot.setControlState("sneak", false);
            this.bot.setControlState("sprint", true);
          }
          break;
      }
    }

    await new Promise<void>((resolve) => {
      const listener = (packet: any) => {
        const ent = this.bot.entities[packet.entityId];
        if (ent !== this.bot.entity) return;
        this.bot._client.removeListener("entity_velocity", listener);
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        this.bot._client.removeListener("entity_velocity", listener);
        resolve();
      }, 500);
      this.bot._client.on("entity_velocity", listener);
    });

    if (this.options.swingConfig.mode === "fullswing") this.reactionaryCrit();
  };

  async attack(target: Entity) {
    if (target?.id === this.target?.id) return;
    this.stop();
    this.target = target;
    if (!this.target) return;
    this.ticksToNextAttack = 0;
    this.ticksSinceLastTargetHurt = 999;
    this.previousBotPosition = this.bot.entity.position.clone();
    const itemToChangeTo = await this.checkForWeapon();
    if (itemToChangeTo) await this.equipWeapon(itemToChangeTo);
    this.bot.tracker.trackEntity(target);
    this.bot.tracker.trackEntity(this.bot.entity);
    this.emit("startedAttacking", this.target);
  }

  stop() {
    if (!this.target) return;
    this.clearShieldToggleListener();
    this.lastTarget = this.target;
    this.bot.tracker.stopTrackingEntity(this.target);
    delete this.target;
    this.comboState = "neutral";
    this.targetVelocityHistory = [];
    this.consecutiveWallHitTicks = 0;
    stopFollow(this.bot, this.options.followConfig.mode);
    this.bot.clearControlStates();
    this.emit("stoppedAttacking");
  }

  update = () => {
    if (!this.target) return;
    this.ticksToNextAttack--;
    this.ticksSinceTargetAttack++;
    this.ticksSinceLastHurt++;
    this.ticksSinceLastTargetHit++;
    this.ticksSinceLastSwitch++;
    this.ticksSinceLastTargetHurt++;

    this.updateComboState();
    this.checkRange();
    this.checkVisibility();
    this.rotate();
    this.doMove();
    this.doStrafe();
    this.seekHeightAdvantage();
    this.checkAntiTrap();
    this.causeCritical();
    this.toggleShield();

    if (this.ticksToNextAttack <= -1 && !this.tickOverride) {
      if (this.bot.entity.velocity.y <= -0.25) this.bot.setControlState("sprint", false);
      if (this.bot.entity.onGround) this.sprintTap();
      if (this.shouldHitSelect()) this.attemptAttack("normal");
    }
  };

  private updateComboState(): void {
    if (this.ticksSinceLastHurt <= 10) {
      this.comboState = "taking-damage";
    } else if (this.ticksSinceLastTargetHit <= 20) {
      this.comboState = "combo";
    } else {
      this.comboState = "neutral";
    }
  }

  private shouldHitSelect(): boolean {
    if (!this.options.hitSelectConfig.enabled) return true;
    if (this.options.hitSelectConfig.iframeGate && this.ticksSinceLastTargetHurt < 10) return false;
    if (
      !this.bot.supportFeature("doesntHaveOffHandSlot") &&
      this.options.hitSelectConfig.requireFullCharge &&
      this.ticksToNextAttack > -1
    ) return false;
    if (this.comboState === "taking-damage" && this.ticksSinceLastHurt < 5) return false;
    return true;
  }

  private getEntityEyeHeight(entity: Entity): number {
    return entity.height * 0.9;
  }

  private getEntityEyePosition(entity: Entity): Vec3 {
    return entity.position.offset(0, this.getEntityEyeHeight(entity), 0);
  }

  botReach(): number {
    if (!this.target) return 10000;
    return getEntityAABB(this.target).distanceToVec(this.getEntityEyePosition(this.bot.entity));
  }

  targetReach(): number {
    if (!this.target) return 10000;
    return getEntityAABB(this.bot.entity).distanceToVec(this.getEntityEyePosition(this.target));
  }

  checkRange() {
    if (!this.target) return;
    const dist = this.target.position.distanceTo(this.bot.entity.position);
    if (dist > this.options.genericConfig.viewDistance) return this.stop();
    const inRange = this.botReach() <= this.options.genericConfig.attackRange;
    if (!this.wasInRange && inRange && this.options.swingConfig.mode === "killaura") this.ticksToNextAttack = -1;
    this.wasInRange = inRange;
  }

  checkVisibility() {
    if (!this.target) return;

    const bb0 = getEntityAABB(this.bot.entity);
    const bb1 = getEntityAABB(this.target);
    if (bb0.intersects(bb1)) {
      this.wasVisible = true;
      return;
    }

    const eyePos = this.getEntityEyePosition(this.bot.entity);
    const eyeDir = this.bot.util.getViewDir();
    const reach = this.options.genericConfig.attackRange;

    const hit = this.bot.util.raytrace.entityRaytrace(eyePos, eyeDir, reach, (e) => e.id === this.target?.id);
    if (hit === this.target) {
      this.wasVisible = true;
      return;
    }

    const feetTarget = this.target.position.offset(0, 0.1, 0);
    const dirToFeet = feetTarget.minus(eyePos).normalize();
    const hitFeet = this.bot.util.raytrace.entityRaytrace(eyePos, dirToFeet, reach, (e) => e.id === this.target?.id);
    this.wasVisible = hitFeet === this.target;
  }

  async causeCritical(): Promise<boolean> {
    if (!this.options.critConfig.enabled || !this.target) return false;
    if ((this.bot.entity as any).isInWater || (this.bot.entity as any).isInLava) return false;
    switch (this.options.critConfig.mode) {
      case "packet":
        if (this.ticksToNextAttack !== -1) return false;
        if (!this.wasInRange) return false;
        if (!this.wasVisible) return false;
        if (!this.bot.entity.onGround) return false;
        if (this.options.critConfig.bypass) {
          this.bot.setControlState("sprint", false);
          this.bot._client.write("position", { ...this.bot.entity.position.offset(0, 0.11, 0), onGround: false });
          this.bot._client.write("position", { ...this.bot.entity.position.offset(0, 0.1100013579, 0), onGround: false });
          this.bot._client.write("position", { ...this.bot.entity.position.offset(0, 0.0000013579, 0), onGround: false });
        } else {
          this.bot._client.write("position", { ...this.bot.entity.position.offset(0, 0.1625, 0), onGround: false });
          this.bot._client.write("position", { ...this.bot.entity.position.offset(0, 4.0e-6, 0), onGround: false });
          this.bot._client.write("position", { ...this.bot.entity.position.offset(0, 1.1e-6, 0), onGround: false });
          this.bot._client.write("position", { ...this.bot.entity.position, onGround: false });
        }
        return true;

      case "shorthop":
        if (this.ticksToNextAttack !== 1) return false;
        if (!this.bot.entity.onGround) return false;
        if (this.botReach() <= ((this.options.critConfig as any).attemptRange || this.options.genericConfig.attackRange)) return false;
        this.bot.entity.position = this.bot.entity.position.offset(0, 0.25, 0);
        this.bot.entity.onGround = false;
        await this.bot.waitForTicks(2);
        const { x: dx, y: dy, z: dz } = this.bot.entity.position;
        this.bot.entity.position = this.bot.entity.position.set(dx, Math.floor(dy), dz);
        return true;

      case "hop":
        if (this.ticksToNextAttack > 8) return false;
        const inReach = this.botReach() <= ((this.options.critConfig as any).attemptRange || this.options.genericConfig.attackRange);
        if (!inReach) return false;
        if (this.ticksToNextAttack !== 8 && !this.willBeFirstHit) return false;
        if (this.willBeFirstHit && !this.bot.entity.onGround) {
          this.reactionaryCrit(true);
          return true;
        }
        this.bot.setControlState("jump", true);
        this.bot.setControlState("jump", false);
        return true;

      default:
        return false;
    }
  }

  async doMove() {
    if (!this.target) {
      this.bot.clearControlStates();
      return;
    }

    const farAway = this.botReach() >= this.options.genericConfig.attackRange;
    if (farAway) {
      this.targetGoal = followEntity(this.bot, this.target, this.options);
      return;
    }

    if (this.targetGoal) {
      stopFollow(this.bot, this.options.followConfig.mode);
      this.targetGoal = undefined;
    }

    if (this.comboState === "taking-damage") {
      this.doBlockHit();
    }

    let shouldApproach = true;

    if (this.options.onHitConfig.enabled) {
      const distCheck = this.targetReach() <= this.options.genericConfig.enemyReach + 1;
      switch (this.options.onHitConfig.mode) {
        case "backoff":
          shouldApproach = this.ticksSinceLastHurt > (this.options.onHitConfig.tickCount ?? 5) && distCheck;
          break;
      }
    }

    if (this.comboState === "combo") {
      shouldApproach = true;
    }

    const tooClose = this.botReach() > this.options.genericConfig.tooCloseRange;
    shouldApproach = shouldApproach && tooClose;

    if (!this.bot.getControlState("back")) {
      this.bot.setControlState("forward", shouldApproach);
      this.bot.setControlState("sprint", shouldApproach);
    }
  }

  private async doBlockHit(): Promise<void> {
    if (!this.options.blockHitConfig.enabled) return;
    if (this.blockHitActive) return;
    if (this.tickOverride) return;
    if (!this.target) return;

    const windowTicks = this.options.blockHitConfig.windowTicks;

    if (this.bot.supportFeature("doesntHaveOffHandSlot")) {
      this.blockHitActive = true;
      this.bot.activateItem(false);
      await this.bot.waitForTicks(windowTicks);
      this.bot.deactivateItem();
      this.blockHitActive = false;
    } else {
      if (this.shieldEquipped() && !this.tickOverride) {
        this.blockHitActive = true;
        this.bot.activateItem(true);
        await this.bot.waitForTicks(windowTicks);
        this.bot.deactivateItem();
        this.blockHitActive = false;
      }
    }
  }

  private seekHeightAdvantage(): void {
    if (!this.options.heightAdvantageConfig.enabled || !this.target) return;
    if (!this.wasInRange) return;
    if (!this.bot.entity.onGround) return;
    const heightDiff = this.bot.entity.position.y - this.target.position.y;
    if (heightDiff >= this.options.heightAdvantageConfig.jumpThreshold) return;
    this.bot.setControlState("jump", true);
    this.bot.setControlState("jump", false);
  }

  private checkAntiTrap(): void {
    if (!this.options.antiTrapConfig.enabled || !this.target) return;

    const currentPos = this.bot.entity.position;
    const delta = currentPos.minus(this.previousBotPosition);
    const xzMove = Math.sqrt(delta.x * delta.x + delta.z * delta.z);

    const movingIntended =
      this.bot.getControlState("forward") || this.bot.getControlState("sprint");

    if (movingIntended && this.bot.entity.onGround && xzMove < 0.04) {
      this.consecutiveWallHitTicks++;
    } else {
      this.consecutiveWallHitTicks = 0;
    }

    this.previousBotPosition = currentPos.clone();

    if (this.consecutiveWallHitTicks >= this.options.antiTrapConfig.detectionTicks) {
      this.bot.setControlState("forward", false);
      this.bot.setControlState("sprint", false);
      const escapeDir: ControlState = this.currentStrafeDir === "left" ? "right" : "left";
      const opposite: ControlState = escapeDir === "left" ? "right" : "left";
      this.bot.setControlState(escapeDir, true);
      this.bot.setControlState(opposite, false);
      this.bot.setControlState("jump", true);
      this.bot.setControlState("jump", false);
      this.consecutiveWallHitTicks = 0;
    }
  }

  async doStrafe() {
    if (!this.target) {
      if (this.currentStrafeDir) {
        this.bot.setControlState(this.currentStrafeDir, false);
        delete this.currentStrafeDir;
      }
      return false;
    }
    if (!this.options.strafeConfig.enabled) return false;

    const diff = getTargetYaw(this.target.position, this.bot.entity.position) - this.target.yaw;
    const shouldMove = Math.abs(diff) < (this.options.strafeConfig.mode.maxOffset ?? PIOver3);
    if (!shouldMove) {
      if (this.currentStrafeDir) this.bot.setControlState(this.currentStrafeDir, false);
      delete this.currentStrafeDir;
      return false;
    }

    switch (this.options.strafeConfig.mode.mode) {
      case "circle": {
        const circleDir: ControlState = diff < 0 ? "right" : "left";
        if (circleDir !== this.currentStrafeDir) {
          if (this.currentStrafeDir) this.bot.setControlState(this.currentStrafeDir, false);
        }
        this.currentStrafeDir = circleDir;
        this.bot.setControlState(circleDir, true);
        break;
      }

      case "random": {
        if (this.strafeCounter < 0) {
          this.strafeCounter = Math.floor(Math.random() * 20) + 5;
          const rand = Math.random();
          const randomDir: ControlState = rand < 0.5 ? "left" : "right";
          const oppositeDir: ControlState = rand >= 0.5 ? "left" : "right";
          if (this.botReach() <= this.options.genericConfig.attackRange + 3) {
            this.bot.setControlState(randomDir, true);
            this.bot.setControlState(oppositeDir, false);
            this.currentStrafeDir = randomDir;
          }
        }
        this.strafeCounter--;
        break;
      }

      case "intelligent": {
        if (this.ticksSinceLastTargetHit > 40) {
          this.bot.setControlState("left", false);
          this.bot.setControlState("right", false);
          delete this.currentStrafeDir;
        } else {
          if (this.strafeCounter < 0 || this.currentStrafeDir === undefined) {
            this.strafeCounter = Math.floor(Math.random() * 20) + 5;
            this.currentStrafeDir = Math.random() < 0.5 ? "left" : "right";
          }
          const oppositeSmartDir: ControlState = this.currentStrafeDir === "left" ? "right" : "left";
          if (this.botReach() <= this.options.genericConfig.attackRange + 3) {
            this.bot.setControlState(this.currentStrafeDir!, true);
            this.bot.setControlState(oppositeSmartDir, false);
          } else {
            if (this.currentStrafeDir) this.bot.setControlState(this.currentStrafeDir, false);
            delete this.currentStrafeDir;
          }
        }
        this.strafeCounter--;
        break;
      }

      case "predictive": {
        const vel = this.target.velocity.clone();
        this.targetVelocityHistory.push(vel);
        if (this.targetVelocityHistory.length > 5) this.targetVelocityHistory.shift();

        const sum = this.targetVelocityHistory.reduce(
          (acc, v) => new Vec3(acc.x + v.x, 0, acc.z + v.z),
          new Vec3(0, 0, 0)
        );
        const avgVel = sum.scaled(1 / this.targetVelocityHistory.length);
        const xzMag = Math.sqrt(avgVel.x * avgVel.x + avgVel.z * avgVel.z);

        if (xzMag < 0.02) {
          if (this.strafeCounter < 0 || this.currentStrafeDir === undefined) {
            this.strafeCounter = Math.floor(Math.random() * 20) + 5;
            this.currentStrafeDir = Math.random() < 0.5 ? "left" : "right";
          }
          this.strafeCounter--;
        } else {
          const heading = new Vec3(avgVel.x / xzMag, 0, avgVel.z / xzMag);
          const rightPerp = new Vec3(heading.z, 0, -heading.x);
          const relPos = this.bot.entity.position.minus(this.target.position);
          const dot = relPos.x * rightPerp.x + relPos.z * rightPerp.z;
          const newDir: ControlState = dot >= 0 ? "right" : "left";
          if (newDir !== this.currentStrafeDir) {
            if (this.currentStrafeDir) this.bot.setControlState(this.currentStrafeDir, false);
            this.currentStrafeDir = newDir;
          }
        }

        if (this.currentStrafeDir) {
          const oppositeDir: ControlState = this.currentStrafeDir === "left" ? "right" : "left";
          if (this.botReach() <= this.options.genericConfig.attackRange + 3) {
            this.bot.setControlState(this.currentStrafeDir, true);
            this.bot.setControlState(oppositeDir, false);
          } else {
            this.bot.setControlState(this.currentStrafeDir, false);
            delete this.currentStrafeDir;
          }
        }
        break;
      }
    }

    return true;
  }

  async sprintTap() {
    if (!this.target) return false;
    if (!this.bot.entity.onGround) return false;
    if (!this.wasInRange) return false;
    if (!this.wasVisible) return false;
    if (!this.options.tapConfig.enabled) return false;

    switch (this.options.tapConfig.mode) {
      case "wtap":
        this.bot.setControlState("forward", false);
        this.bot.setControlState("sprint", false);
        this.bot.setControlState("forward", true);
        this.bot.setControlState("sprint", true);
        break;

      case "stap":
        do {
          this.bot.setControlState("forward", false);
          this.bot.setControlState("sprint", false);
          this.bot.setControlState("back", true);
          const looking = movingAt(
            this.target.position,
            this.bot.entity.position,
            this.bot.tracker.getEntitySpeed(this.target) ?? new Vec3(0, 0, 0),
            PIOver3
          );
          if (!looking && this.wasInRange) break;
          await this.bot.waitForTicks(1);
        } while (this.botReach() < this.options.genericConfig.attackRange + 0.1);

        this.bot.setControlState("back", false);
        this.bot.setControlState("forward", true);
        this.bot.setControlState("sprint", true);
        break;

      default:
        break;
    }

    return true;
  }

  async toggleShield() {
    if (this.ticksToNextAttack !== 0 || !this.target || !this.wasInRange || !this.wasVisible) return false;
    const shield = this.shieldEquipped();
    const wasShieldActive = shield;
    this.clearShieldToggleListener();

    if (wasShieldActive && this.options.shieldConfig.enabled && this.options.shieldConfig.mode === "legit") {
      this.bot.deactivateItem();
    }

    this.shieldToggleListener = async (_entity: Entity) => {
      this.clearShieldToggleListener();
      await this.bot.waitForTicks(3);
      if (wasShieldActive && this.options.shieldConfig.enabled && this.options.shieldConfig.mode === "legit") {
        this.bot.activateItem(true);
      } else if (!this.bot.util.entity.isOffHandActive() && shield && this.options.shieldConfig.mode === "blatant") {
        this.bot.activateItem(true);
      }
    };

    this.on("attackedTarget", this.shieldToggleListener);
    return true;
  }

  rotate() {
    if (!this.options.rotateConfig.enabled || !this.target) return false;
    if (!this.options.rotateConfig.lookAtHidden && !this.wasVisible) return false;

    const bodyCenter = this.target.position.offset(0, this.target.height * 0.5, 0);

    const lookFunc = this.options.rotateConfig.smooth
      ? this.bot.smoothLook.lookAt.bind(this.bot.smoothLook)
      : this.bot.lookAt.bind(this.bot);

    if (this.options.rotateConfig.mode === "constant") {
      lookFunc(bodyCenter);
      return true;
    }

    if (this.ticksToNextAttack !== -1) return false;

    switch (this.options.rotateConfig.mode) {
      case "legit":
        lookFunc(bodyCenter);
        break;
      case "instant":
        this.bot.lookAt(bodyCenter, true);
        break;
      case "silent":
        this.bot.util.move.forceLookAt(bodyCenter);
        break;
      case "ignore":
        break;
      default:
        break;
    }

    return true;
  }

  async reactionaryCrit(noTickLimit = false) {
    if (!this.options.critConfig.reaction.enabled) return;
    if (!this.target) return;
    if (this.tickOverride) return;
    this.tickOverride = true;

    for (let i = 0; i < 12; i++) {
      await this.bot.waitForTicks(1);
      if (this.bot.entity.onGround) {
        this.tickOverride = false;
        return;
      }
      if (this.options.critConfig.reaction.maxWaitDistance) {
        if (this.botReach() >= this.options.critConfig.reaction.maxWaitDistance) {
          this.tickOverride = false;
          return;
        }
      }
      if (
        this.bot.entity.velocity.y <= -0.25 &&
        this.ticksToNextAttack <= -1 + ((this.options.critConfig.reaction as any).maxPreemptiveTicks ?? 0)
      ) {
        break;
      }
      if ((this.options.critConfig.reaction as any).maxWaitTicks && !noTickLimit) {
        if (this.ticksToNextAttack <= -1 - (this.options.critConfig.reaction as any).maxWaitTicks) {
          break;
        }
      }
    }

    this.bot.setControlState("sprint", false);
    await this.attemptAttack("reaction");
    this.tickOverride = false;
  }

  async attemptAttack(reason: string) {
    if (!this.target) return;
    if (!this.wasInRange) {
      this.willBeFirstHit = true;
      return;
    }
    if (!this.options.genericConfig.hitThroughWalls && !this.wasVisible) return;

    while (Math.random() < this.options.genericConfig.missChancePerTick) {
      await this.bot.waitForTicks(1);
      if (!this.target || !this.wasInRange) return;
    }

    attack(this.bot, this.target);
    this.willBeFirstHit = false;
    this.ticksSinceLastTargetHit = 0;

    this.emit("attackedTarget", this.target, reason, this.ticksToNextAttack);
    this.ticksToNextAttack = this.meleeAttackRate.getTicks(this.bot.heldItem!);
  }

  shieldEquipped() {
    if (this.bot.supportFeature("doesntHaveOffHandSlot")) return false;
    const slot = this.bot.inventory.slots[this.bot.getEquipmentDestSlot("off-hand")];
    if (!slot) return false;
    return slot.name.includes("shield");
  }
}
