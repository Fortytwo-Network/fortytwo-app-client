#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setVerbose, log } from "./utils.js";
import {
  configExists,
  get as getConfig,
  reloadConfig,
} from "./config.js";
import { loadIdentity, registerAgent } from "./identity.js";
import { FortyTwoClient } from "./api-client.js";
import { main } from "./main.js";
import { executeCommand } from "./commands.js";
import { validateModel, buildConfig } from "./setup-logic.js";
import { startViewerServer } from "./viewer-server.js";
import { checkForUpdate, UPDATE_COMMAND } from "./update-check.js";
import pkg from "../package.json" with { type: "json" };
import {
  initProfiles,
  setProfileOverride,
  listProfiles,
  switchProfile,
  deleteProfile,
  createProfile,
  sanitizeProfileName,
  getProfileDir,
} from "./profiles.js";

// ── Arg parser ──────────────────────────────────────────────────

interface ParsedArgs {
  subcommand: string | null;
  flags: Record<string, string>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  if (args.length === 0) return { subcommand: null, flags: {}, positionals: [] };

  const subcommand = args[0].startsWith("-") ? null : args[0];
  const rest = subcommand ? args.slice(1) : args;
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx >= 0) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const next = rest[i + 1];
        if (next && !next.startsWith("--")) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = "true";
        }
      }
    } else if (arg === "-v") {
      flags["verbose"] = "true";
    } else if (arg === "-p") {
      const next = rest[i + 1];
      if (next && !next.startsWith("-")) {
        flags["profile"] = next;
        i++;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { subcommand, flags, positionals };
}

// ── Commands ────────────────────────────────────────────────────

function requireFlag(flags: Record<string, string>, name: string, label: string): string {
  const val = flags[name];
  if (!val || val === "true") {
    console.error(`Missing required flag: --${name} (${label})`);
    process.exit(1);
  }
  return val;
}

async function cmdSetup(flags: Record<string, string>) {
  const nodeName = requireFlag(flags, "node-name", "node name");
  const inferenceType = requireFlag(flags, "inference-type", "openrouter | local");
  const model = requireFlag(flags, "model", "model name");
  const role = requireFlag(flags, "node-role", "JUDGE | ANSWERER | ANSWERER_AND_JUDGE");

  if (!["openrouter", "self-hosted"].includes(inferenceType)) {
    console.error(`Invalid --inference-type: ${inferenceType}. Must be "openrouter" or "self-hosted".`);
    process.exit(1);
  }

  if (!["JUDGE", "ANSWERER", "ANSWERER_AND_JUDGE"].includes(role)) {
    console.error(`Invalid --role: ${role}. Must be JUDGE, ANSWERER, or ANSWERER_AND_JUDGE.`);
    process.exit(1);
  }

  const values: Record<string, string> = {
    node_name: nodeName,
    node_display_name: nodeName,
    inference_type: inferenceType,
    llm_model: model,
    node_role: role,
  };

  if (inferenceType === "openrouter") {
    values.openrouter_api_key = requireFlag(flags, "api-key", "OpenRouter API key");
  } else {
    values.llm_api_base = requireFlag(flags, "llm-api-base", "local inference URL");
  }

  if (!flags["skip-validation"]) {
    console.log("Validating model...");
    const result = await validateModel(values);
    if (!result.ok) {
      console.error(`Validation failed: ${result.error}`);
      process.exit(1);
    }
    console.log("Model OK.");
  }

  const cfg = buildConfig(values);
  const profileName = sanitizeProfileName(nodeName);
  createProfile(profileName, cfg);
  reloadConfig();
  console.log(`Config saved to profile "${profileName}".`);

  console.log("Starting registration...");
  const client = new FortyTwoClient();
  await registerAgent(client, nodeName, console.log);
  console.log("Setup complete!");
}

async function cmdImport(flags: Record<string, string>) {
  const nodeId = requireFlag(flags, "node-id", "agent UUID");
  const nodeSecret = requireFlag(flags, "node-secret", "node secret");
  const inferenceType = requireFlag(flags, "inference-type", "openrouter | local");
  const model = requireFlag(flags, "model", "model name");
  const role = requireFlag(flags, "node-role", "JUDGE | ANSWERER | ANSWERER_AND_JUDGE");

  if (!["openrouter", "local"].includes(inferenceType)) {
    console.error(`Invalid --inference-type: ${inferenceType}. Must be "openrouter" or "local".`);
    process.exit(1);
  }

  if (!["JUDGE", "ANSWERER", "ANSWERER_AND_JUDGE"].includes(role)) {
    console.error(`Invalid --role: ${role}. Must be JUDGE, ANSWERER, or ANSWERER_AND_JUDGE.`);
    process.exit(1);
  }

  console.log("Checking credentials...");
  const client = new FortyTwoClient();
  try {
    await client.login(nodeId, nodeSecret);
  } catch (err) {
    console.error(`Invalid credentials: ${err}`);
    process.exit(1);
  }

  let nodeDisplayName = nodeId;
  try {
    const agent = await client.getAgent();
    nodeDisplayName = agent?.profile?.display_name || nodeDisplayName;
  } catch { /* keep nodeId */ }

  const values: Record<string, string> = {
    node_name: nodeDisplayName,
    node_display_name: nodeDisplayName,
    node_id: nodeId,
    inference_type: inferenceType,
    llm_model: model,
    node_role: role,
  };

  if (inferenceType === "openrouter") {
    values.openrouter_api_key = requireFlag(flags, "openrouter-api-key", "OpenRouter API key");
  } else {
    values.self_hosted_api_base = requireFlag(flags, "self-hosted-api-base", "local inference URL");
  }

  if (!flags["skip-validation"]) {
    console.log("Validating model...");
    const result = await validateModel(values);
    if (!result.ok) {
      console.error(`Validation failed: ${result.error}`);
      process.exit(1);
    }
    console.log("Model OK.");
  }

  const cfg = buildConfig(values);
  const profileName = sanitizeProfileName(nodeDisplayName);
  createProfile(profileName, cfg, { node_id: nodeId, node_secret: nodeSecret });
  reloadConfig();
  console.log(`Agent "${nodeDisplayName}" (${nodeId}) imported to profile "${profileName}"!`);
}

async function cmdRun() {
  if (!configExists()) {
    console.error("No config found. Run 'setup' or 'import' first.");
    process.exit(1);
  }

  const cfg = getConfig();
  const identity = loadIdentity(cfg.node_identity_file);
  if (!identity) {
    console.error("No identity found. Run 'setup' or 'import' first.");
    process.exit(1);
  }

  const viewer = startViewerServer(4242);
  log(`Watch your node -> http://127.0.0.1:${viewer.port}`);

  const ac = new AbortController();
  const shutdown = () => {
    log("Shutting down...");
    viewer.close();
    ac.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await main(ac.signal);
}

async function cmdAsk(positionals: string[]) {
  const question = positionals.join(" ").trim();
  if (!question) {
    console.error("Usage: fortytwo ask <question>");
    process.exit(1);
  }

  if (!configExists()) {
    console.error("No config found. Run 'setup' or 'import' first.");
    process.exit(1);
  }

  const cfg = getConfig();
  const identity = loadIdentity(cfg.node_identity_file);
  if (!identity) {
    console.error("No identity found. Run 'setup' or 'import' first.");
    process.exit(1);
  }

  const client = new FortyTwoClient();
  await client.login(identity.node_id, identity.node_secret);

  const encrypted = Buffer.from(question, "utf-8").toString("base64");
  const res = await client.createQuery(encrypted, "general");
  console.log(`Question submitted! ID: ${res.id ?? "?"}`);
}

function cmdConfig(positionals: string[]) {
  const sub = positionals[0];
  if (sub === "show") {
    for (const line of executeCommand("/config show")) console.log(line);
  } else if (sub === "set") {
    const key = positionals[1];
    const value = positionals.slice(2).join(" ");
    if (!key || !value) {
      console.error("Usage: fortytwo config set <key> <value>");
      process.exit(1);
    }
    for (const line of executeCommand(`/config set ${key} ${value}`)) console.log(line);
  } else {
    console.error("Usage: fortytwo config show | fortytwo config set <key> <value>");
    process.exit(1);
  }
}

function cmdIdentity() {
  for (const line of executeCommand("/identity")) console.log(line);
}

async function cmdProfile(positionals: string[]) {
  const sub = positionals[0];

  if (!sub || sub === "list") {
    const profiles = listProfiles();
    if (profiles.length === 0) {
      console.log("No profiles. Run 'fortytwo setup' or 'fortytwo import' to create one.");
      return;
    }
    console.log("Profiles:");
    for (const p of profiles) {
      const marker = p.active ? " (active)" : "";
      console.log(`  ${p.name}${marker}`);
    }
    return;
  }

  if (sub === "switch") {
    const name = positionals[1];
    if (!name) {
      const profiles = listProfiles();
      if (profiles.length === 0) {
        console.error("No profiles available.");
        process.exit(1);
      }
      console.log("Available profiles:");
      for (const p of profiles) {
        const marker = p.active ? " (active)" : "";
        console.log(`  ${p.name}${marker}`);
      }
      console.log("\nUsage: fortytwo profile switch <name>");
      return;
    }
    try {
      switchProfile(name);
      console.log(`Switched to profile "${name}".`);
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(1);
    }
    return;
  }

  if (sub === "create") {
    const { setConfigDir } = await import("./config.js");
    const tempName = `new-${Date.now()}`;
    setConfigDir(getProfileDir(tempName));
    await import("./index.js");
    return;
  }

  if (sub === "delete") {
    const name = positionals[1];
    if (!name) {
      console.error("Usage: fortytwo profile delete <name>");
      process.exit(1);
    }
    try {
      deleteProfile(name);
      console.log(`Profile "${name}" deleted.`);
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(1);
    }
    return;
  }

  if (sub === "show") {
    const name = positionals[1];
    const profiles = listProfiles();
    const target = name
      ? profiles.find((p) => p.name === name)
      : profiles.find((p) => p.active);
    if (!target) {
      console.error(name ? `Profile "${name}" not found.` : "No active profile.");
      process.exit(1);
    }

    const dir = getProfileDir(target.name);
    const cfgPath = join(dir, "config.json");
    if (!existsSync(cfgPath)) {
      console.error(`Config not found for profile "${target.name}".`);
      process.exit(1);
    }
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    console.log(`Profile: ${target.name}${target.active ? " (active)" : ""}`);
    for (const [k, v] of Object.entries(cfg)) {
      const display = (k === "openrouter_api_key" && typeof v === "string" && v.length > 8)
        ? v.slice(0, 4) + "***" + v.slice(-4)
        : String(v);
      console.log(`  ${k}: ${display}`);
    }
    return;
  }

  console.error(`Unknown profile command: ${sub}`);
  console.error("Usage: fortytwo profile list|switch|create|delete|show");
  process.exit(1);
}

function printHelp() {
  console.log(`fortytwo — FortyTwo Network Swarm Client

Usage:
  fortytwo                          Interactive UI
  fortytwo setup [flags]            Register new node
  fortytwo import [flags]           Import existing node
  fortytwo run [-v]                 Run node (headless)
  fortytwo ask <question>           Submit a question
  fortytwo config show              Show config
  fortytwo config set <key> <value> Update config
  fortytwo identity                 Show node credentials
  fortytwo profile list             List all profiles
  fortytwo profile switch <name>    Switch active profile
  fortytwo profile create           Create new profile (interactive)
  fortytwo profile delete <name>    Delete a profile
  fortytwo profile show [name]      Show profile config
  fortytwo version                  Show version

Setup flags:
  --node-name NAME         Node local name
  --inference-type TYPE    openrouter | self-hosted
  --openrouter-api-key KEY OpenRouter API key
  --model-name NAME        Model name
  --self-hosted-api-base URL Local inference URL
  --node-name NAME         Local name for the node profile (e.g. "my-judge")
  --node-role ROLE         JUDGE | ANSWERER | ANSWERER_AND_JUDGE
  --skip-validation        Skip model validation

Import flags:
  --node-id UUID          Node ID
  --node-secret SECRET     Node secret
  (+ same inference/model/role flags as setup)

Global flags:
  -v, --verbose            Verbose logging
  -p, --profile NAME       Use specific profile for this command`);
}

// ── Dispatch ────────────────────────────────────────────────────

async function run() {
  const { subcommand, flags, positionals } = parseArgs(process.argv);

  if (flags.verbose || flags.v) setVerbose(true);

  // Initialize profile system
  if (flags.profile) setProfileOverride(flags.profile);
  initProfiles();

  // Fire-and-forget update check (don't block startup)
  const updatePromise = checkForUpdate().catch(() => null);

  try {
    switch (subcommand) {
      case null:
        await import("./index.js");
        break;
      case "setup":
        await cmdSetup(flags);
        break;
      case "import":
        await cmdImport(flags);
        break;
      case "run":
        await cmdRun();
        break;
      case "ask":
        await cmdAsk(positionals);
        break;
      case "config":
        cmdConfig(positionals);
        break;
      case "identity":
        cmdIdentity();
        break;
      case "profile":
        await cmdProfile(positionals);
        break;
      case "version":
        console.log(pkg.version);
        break;
      case "help":
        printHelp();
        break;
      default:
        console.error(`Unknown command: ${subcommand}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err}`);
    process.exit(1);
  }

  // Show update notification for CLI subcommands (interactive mode handles it in UI)
  if (subcommand !== null) {
    const updateInfo = await updatePromise;
    if (updateInfo?.updateAvailable) {
      console.log(`\nUpdate available: ${updateInfo.currentVersion} → ${updateInfo.latestVersion}`);
      console.log(`Run: ${UPDATE_COMMAND}`);
    }
  }
}

run();
