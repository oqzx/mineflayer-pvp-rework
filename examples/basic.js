const mineflayer = require("mineflayer");
const { Movements } = require("mineflayer-pathfinder");
const customPvpModule = require("../lib");

const customPvp = customPvpModule.default;
const { defaultConfig } = customPvpModule;

const bot = mineflayer.createBot({
  username: process.argv[5] || "pvp-testing",
  host: process.argv[2] || "localhost",
  port: Number(process.argv[3]) || 25565,
  version: process.argv[4],
});

const config = clone(defaultConfig);
config.multiEnemy.enabled = false;
config.multiEnemy.assistTeammates = false;
let debugEnabled = true;

bot.once("spawn", async () => {
  bot.physics.yawSpeed = 6000;
  bot.loadPlugin((instance) => customPvp(instance, config));

  const movements = new Movements(bot);
  movements.allowFreeMotion = true;
  movements.allowParkour = true;
  movements.allowSprinting = true;
  bot.pathfinder.setMovements(movements);

  wireDebugEvents();

  await bot.waitForTicks(20);
  logStatus("spawned");
  tell(
    "ready: use 'pvp help' for commands. start with 'pvp fight' or 'pvp fight <name>'.",
  );
  tell("startup profile is passive: no auto-targeting until you issue a pvp command.");
});

bot.on("chat", (username, message) => {
  if (username === bot.username) return;
  void handleCommand(username, message);
});

bot.on("kicked", (reason) => console.log("[kicked]", reason));
bot.on("error", (error) => console.log("[error]", error));
bot._client.on("end", (reason) => console.log("[end]", reason));
bot._client.on("error", (error) => console.log("[client error]", error));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tell(message) {
  console.log(`[pvp] ${message}`);
  bot.chat(message);
}

function logStatus(prefix) {
  const targetName = getEntityName(bot.pvp.target) || "none";
  console.log(
    `[pvp] ${prefix} | phase=${bot.pvp.phase} target=${targetName} teammates=${config.teammates.join(",") || "none"}`,
  );
}

function wireDebugEvents() {
  bot.on("startedAttacking", (target) => {
    if (!debugEnabled) return;
    console.log(`[event] startedAttacking -> ${getEntityName(target)}`);
  });

  bot.on("attackedTarget", (target) => {
    if (!debugEnabled) return;
    console.log(`[event] attackedTarget -> ${getEntityName(target)}`);
  });

  bot.on("stoppedAttacking", () => {
    if (!debugEnabled) return;
    console.log("[event] stoppedAttacking");
  });

  bot.on("pvpPhaseChanged", (phase) => {
    if (!debugEnabled) return;
    console.log(`[event] pvpPhaseChanged -> ${phase}`);
  });
}

function getEntityName(entity) {
  if (!entity) return null;
  return entity.username || entity.displayName || entity.name || `entity:${entity.id}`;
}

function getCombatCandidates() {
  return Object.values(bot.entities).filter((entity) => {
    if (!entity || entity === bot.entity) return false;
    if (config.teammates.includes(entity.username || "") || config.teammates.includes(entity.name || "")) {
      return false;
    }
    return entity.type === "player" || entity.type === "hostile";
  });
}

function findTarget(query) {
  const candidates = getCombatCandidates();
  if (!query || query === "nearest") {
    return bot.nearestEntity((entity) => candidates.some((candidate) => candidate.id === entity.id));
  }

  const lowered = query.toLowerCase();
  return (
    candidates.find((entity) => (getEntityName(entity) || "").toLowerCase() === lowered) ||
    candidates.find((entity) => (getEntityName(entity) || "").toLowerCase().startsWith(lowered))
  );
}

function summarizeThreats() {
  const threats = getCombatCandidates()
    .map((entity) => ({
      name: getEntityName(entity),
      distance: bot.entity.position.distanceTo(entity.position),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);

  if (!threats.length) return "none";
  return threats.map((entry) => `${entry.name}@${entry.distance.toFixed(1)}`).join(", ");
}

function getAtPath(root, path) {
  const parts = path.split(".");
  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function coerceValue(raw, currentValue) {
  if (Array.isArray(currentValue) || (currentValue && typeof currentValue === "object")) {
    return JSON.parse(raw);
  }

  if (typeof currentValue === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error("expected true or false");
  }

  if (typeof currentValue === "number") {
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) throw new Error("expected a number");
    return parsed;
  }

  if (raw === "true") return true;
  if (raw === "false") return false;

  const maybeNumber = Number(raw);
  if (!Number.isNaN(maybeNumber) && raw.trim() !== "") return maybeNumber;

  return raw;
}

function setAtPath(root, path, rawValue) {
  const parts = path.split(".");
  const leaf = parts.pop();
  if (!leaf) throw new Error("missing config path");

  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      throw new Error(`unknown path segment '${part}'`);
    }
    current = current[part];
  }

  if (!current || typeof current !== "object" || !(leaf in current)) {
    throw new Error(`unknown path '${path}'`);
  }

  const existing = current[leaf];
  const next = coerceValue(rawValue, existing);
  mutateValue(existing, next, current, leaf);
  return current[leaf];
}

function mutateValue(existing, next, parent, key) {
  if (Array.isArray(existing) && Array.isArray(next)) {
    existing.splice(0, existing.length, ...next);
    return;
  }

  if (existing && typeof existing === "object" && next && typeof next === "object" && !Array.isArray(next)) {
    const existingKeys = Object.keys(existing);
    for (const childKey of existingKeys) {
      if (!(childKey in next)) delete existing[childKey];
    }
    for (const [childKey, childValue] of Object.entries(next)) {
      if (childKey in existing) {
        mutateValue(existing[childKey], childValue, existing, childKey);
      } else {
        existing[childKey] = childValue;
      }
    }
    return;
  }

  parent[key] = next;
}

function applyProfile(profileName) {
  resetConfig();

  switch (profileName) {
    case "default":
      break;
    case "duel":
      config.multiEnemy.enabled = false;
      config.multiEnemy.assistTeammates = false;
      config.follow.mode = "jump";
      config.critical.mode = "shorthop";
      config.decisionEngine.aggressionBias = 0.7;
      config.decisionEngine.defensiveBias = 0.15;
      break;
    case "aggressive":
      config.generic.attackRange = 3.15;
      config.cps.max = 18;
      config.follow.distance = 2.4;
      config.strafe.mode = "predictive";
      config.critical.enabled = true;
      config.critical.mode = "hop";
      config.wTap.enabled = true;
      config.blockHit.enabled = true;
      config.decisionEngine.aggressionBias = 0.8;
      config.decisionEngine.defensiveBias = 0.1;
      break;
    case "defensive":
      config.gap.enabled = true;
      config.gap.eatDuringCombat = true;
      config.lowHealth.threshold = 14;
      config.lowHealth.preferBlockOverAttack = true;
      config.pearl.defensiveEnabled = true;
      config.shield.mode = "blatant";
      config.decisionEngine.aggressionBias = 0.25;
      config.decisionEngine.defensiveBias = 0.7;
      break;
    case "chaos":
      config.multiEnemy.enabled = true;
      config.multiEnemy.assistTeammates = true;
      config.bow.enabled = true;
      config.fireball.enabled = true;
      config.pearl.enabled = true;
      config.pearl.defensiveEnabled = true;
      config.dodge.enabled = true;
      config.jumpBoost.enabled = true;
      config.prediction.enabled = true;
      config.behaviorBlend.enabled = true;
      break;
    default:
      throw new Error(`unknown preset '${profileName}'`);
  }
}

function resetConfig() {
  mutateValue(config, clone(defaultConfig), { config }, "config");
}

async function startFight(query) {
  const target = findTarget(query);
  if (!target) {
    tell(`no target found for '${query || "nearest"}'`);
    return;
  }

  bot.pvp.attack(target);
  tell(`attacking ${getEntityName(target)} | phase=${bot.pvp.phase}`);
}

async function handleCommand(username, message) {
  const args = message.trim().split(/\s+/);
  if (args[0] !== "pvp") return;

  const command = args[1] || "help";

  try {
    switch (command) {
      case "help":
        tell(
          "commands: help, fight [name], stop, status, phase, target, threats, preset <default|duel|aggressive|defensive|chaos>, get <path>, set <path> <value>, team <add|remove|list|clear> [name], debug <on|off>",
        );
        break;
      case "fight":
        await startFight(args[2]);
        break;
      case "stop":
        bot.pvp.stop();
        tell("stopped pvp");
        break;
      case "status":
        tell(
          `phase=${bot.pvp.phase} target=${getEntityName(bot.pvp.target) || "none"} threats=${summarizeThreats()}`,
        );
        logStatus(`status requested by ${username}`);
        break;
      case "phase":
        tell(`phase=${bot.pvp.phase}`);
        break;
      case "target":
        tell(`target=${getEntityName(bot.pvp.target) || "none"}`);
        break;
      case "threats":
        tell(`threats=${summarizeThreats()}`);
        break;
      case "preset":
        applyProfile(args[2] || "default");
        tell(`preset '${args[2] || "default"}' applied`);
        break;
      case "get": {
        const path = args[2];
        if (!path) throw new Error("usage: pvp get <path>");
        const value = getAtPath(config, path);
        if (value === undefined) throw new Error(`unknown path '${path}'`);
        tell(`${path}=${JSON.stringify(value)}`);
        break;
      }
      case "set": {
        const path = args[2];
        const rawValue = args.slice(3).join(" ");
        if (!path || !rawValue) throw new Error("usage: pvp set <path> <value>");
        const nextValue = setAtPath(config, path, rawValue);
        tell(`${path}=${JSON.stringify(nextValue)}`);
        break;
      }
      case "team": {
        const action = args[2];
        const name = args[3];
        switch (action) {
          case "add":
            if (!name) throw new Error("usage: pvp team add <name>");
            if (!config.teammates.includes(name)) config.teammates.push(name);
            tell(`teammates=${config.teammates.join(",") || "none"}`);
            break;
          case "remove":
            if (!name) throw new Error("usage: pvp team remove <name>");
            {
              const index = config.teammates.indexOf(name);
              if (index >= 0) config.teammates.splice(index, 1);
            }
            tell(`teammates=${config.teammates.join(",") || "none"}`);
            break;
          case "clear":
            config.teammates.splice(0, config.teammates.length);
            tell("teammates=none");
            break;
          case "list":
          default:
            tell(`teammates=${config.teammates.join(",") || "none"}`);
            break;
        }
        break;
      }
      case "debug":
        debugEnabled = (args[2] || "on") === "on";
        tell(`debug=${debugEnabled}`);
        break;
      default:
        tell(`unknown command '${command}'. use 'pvp help'.`);
        break;
    }
  } catch (error) {
    tell(`command failed: ${error.message}`);
  }
}
