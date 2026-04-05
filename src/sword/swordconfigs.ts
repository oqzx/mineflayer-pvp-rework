import { Bot } from "mineflayer";

export interface FullConfig {
  genericConfig: GenericConfig;
  tapConfig: TapConfig;
  onHitConfig: OnHitConfig;
  strafeConfig: StrafeConfig;
  swingConfig: SwingBehaviorConfig;
  critConfig: CriticalsConfig;
  shieldConfig: ShieldConfig;
  shieldDisableConfig: ShieldDisableConfig;
  rotateConfig: RotateConfig;
  followConfig: FollowConfig;
  hitSelectConfig: HitSelectConfig;
  blockHitConfig: BlockHitConfig;
  heightAdvantageConfig: HeightAdvantageConfig;
  antiTrapConfig: AntiTrapConfig;
  cps?: number;
}

export type ShieldDisableConfig = {
  enabled: boolean;
  mode: "single" | "double";
};

export type GenericConfig = {
  viewDistance: number;
  attackRange: number;
  tooCloseRange: number;
  missChancePerTick: number;
  enemyReach: number;
  hitThroughWalls: boolean;
};

export type SwingBehaviorConfig = {
  mode: "killaura" | "fullswing";
};

export type StrafeModeConfig = {
  mode: "circle" | "random" | "intelligent" | "predictive";
  maxOffset?: number;
};

export type StrafeConfig = {
  enabled: boolean;
  mode: StrafeModeConfig;
};

export type TapConfig = {
  enabled: boolean;
  mode: "wtap" | "stap" | "sprintcancel";
  delay: number;
};

export type KBConfig =
  | { enabled: boolean; mode: "jump" }
  | { enabled: boolean; mode: "velocity"; hRatio?: number; yRatio: number }
  | { enabled: boolean; mode: "shift" | "jumpshift"; delay?: number };

export type OnHitConfig = {
  enabled: boolean;
  mode: "backoff";
  kbCancel: KBConfig;
  tickCount?: number;
};

export type ReactionCritConfig =
  | { enabled: false }
  | { enabled: true; maxWaitTicks?: number; maxWaitDistance?: number; maxPreemptiveTicks?: number };

export type CriticalsConfig = {
  enabled: boolean;
  reaction: ReactionCritConfig;
} & (
  | { mode: "hop" | "shorthop"; attemptRange?: number }
  | { enabled: boolean; mode: "packet"; bypass?: boolean }
);

export type ShieldConfig = {
  enabled: boolean;
  mode: "legit" | "blatant";
};

export type RotateConfig = {
  enabled: boolean;
  smooth: boolean;
  lookAtHidden: boolean;
  mode: "legit" | "instant" | "constant" | "silent" | "ignore";
};

export type FollowConfig = {
  mode: "jump" | "standard";
  distance: number;
} & ({ predict: false } | { predict: true; predictTicks?: number });

export type HitSelectConfig = {
  enabled: boolean;
  requireFullCharge: boolean;
  iframeGate: boolean;
};

export type BlockHitConfig = {
  enabled: boolean;
  windowTicks: number;
};

export type HeightAdvantageConfig = {
  enabled: boolean;
  jumpThreshold: number;
};

export type AntiTrapConfig = {
  enabled: boolean;
  detectionTicks: number;
};

export const defaultConfig: FullConfig = {
  genericConfig: {
    viewDistance: 128,
    attackRange: 3,
    tooCloseRange: 2.5,
    missChancePerTick: 0.0,
    enemyReach: 3,
    hitThroughWalls: false,
  },
  tapConfig: {
    enabled: true,
    mode: "wtap",
    delay: 0,
  },
  strafeConfig: {
    enabled: true,
    mode: {
      mode: "predictive",
      maxOffset: Math.PI / 2,
    },
  },
  critConfig: {
    enabled: true,
    mode: "hop",
    attemptRange: 2,
    reaction: {
      enabled: true,
      maxPreemptiveTicks: 1,
      maxWaitTicks: 5,
      maxWaitDistance: 5,
    },
  },
  onHitConfig: {
    enabled: true,
    mode: "backoff",
    kbCancel: {
      enabled: true,
      mode: "jump",
    },
  },
  rotateConfig: {
    enabled: true,
    smooth: false,
    lookAtHidden: true,
    mode: "constant",
  },
  shieldConfig: {
    enabled: true,
    mode: "legit",
  },
  shieldDisableConfig: {
    enabled: true,
    mode: "single",
  },
  swingConfig: {
    mode: "fullswing",
  },
  followConfig: {
    mode: "standard",
    distance: 3,
    predict: true,
    predictTicks: 4,
  },
  hitSelectConfig: {
    enabled: true,
    requireFullCharge: true,
    iframeGate: true,
  },
  blockHitConfig: {
    enabled: true,
    windowTicks: 3,
  },
  heightAdvantageConfig: {
    enabled: true,
    jumpThreshold: 0.4,
  },
  antiTrapConfig: {
    enabled: true,
    detectionTicks: 4,
  },
  cps: 15,
};

export function getConfig(bot: Bot): FullConfig {
  const ret = JSON.parse(JSON.stringify(defaultConfig)) as FullConfig;
  if (bot.supportFeature("doesntHaveOffHandSlot")) {
    ret.critConfig.reaction.enabled = false;
    ret.shieldDisableConfig.enabled = false;
    ret.shieldConfig.enabled = false;
  }
  return ret;
}
