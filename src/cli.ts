#!/usr/bin/env node
import { setVerbose, log } from "./utils.js";
import {
  configExists,
  get as getConfig,
  saveConfig,
  reloadConfig,
} from "./config.js";
import { loadIdentity, saveIdentity, registerAgent } from "./identity.js";
import { FortyTwoClient } from "./api-client.js";
import { main } from "./main.js";
import { executeCommand } from "./commands.js";
import { validateModel, buildConfig } from "./setup-logic.js";

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
  const name = requireFlag(flags, "name", "agent display name");
  const inferenceType = requireFlag(flags, "inference-type", "openrouter | local");
  const model = requireFlag(flags, "model", "model name");
  const role = requireFlag(flags, "role", "JUDGE | ANSWERER | ANSWERER_AND_JUDGE");

  if (!["openrouter", "local"].includes(inferenceType)) {
    console.error(`Invalid --inference-type: ${inferenceType}. Must be "openrouter" or "local".`);
    process.exit(1);
  }

  if (!["JUDGE", "ANSWERER", "ANSWERER_AND_JUDGE"].includes(role)) {
    console.error(`Invalid --role: ${role}. Must be JUDGE, ANSWERER, or ANSWERER_AND_JUDGE.`);
    process.exit(1);
  }

  const values: Record<string, string> = {
    agent_name: name,
    inference_type: inferenceType,
    llm_model: model,
    bot_role: role,
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
  saveConfig(cfg);
  reloadConfig();
  console.log("Config saved.");

  console.log("Starting registration...");
  const client = new FortyTwoClient();
  await registerAgent(client, name, console.log);
  console.log("Setup complete!");
}

async function cmdImport(flags: Record<string, string>) {
  const agentId = requireFlag(flags, "agent-id", "agent UUID");
  const secret = requireFlag(flags, "secret", "agent secret");
  const inferenceType = requireFlag(flags, "inference-type", "openrouter | local");
  const model = requireFlag(flags, "model", "model name");
  const role = requireFlag(flags, "role", "JUDGE | ANSWERER | ANSWERER_AND_JUDGE");

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
    await client.login(agentId, secret);
  } catch (err) {
    console.error(`Invalid credentials: ${err}`);
    process.exit(1);
  }

  let displayName = agentId;
  try {
    const agent = await client.getAgent();
    displayName = agent?.profile?.display_name || displayName;
  } catch { /* keep agentId */ }

  const values: Record<string, string> = {
    agent_name: displayName,
    agent_id: agentId,
    inference_type: inferenceType,
    llm_model: model,
    bot_role: role,
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
  saveConfig(cfg);
  reloadConfig();

  saveIdentity(getConfig().identity_file, { agent_id: agentId, secret });
  console.log(`Agent "${displayName}" (${agentId}) imported!`);
}

async function cmdRun() {
  if (!configExists()) {
    console.error("No config found. Run 'setup' or 'import' first.");
    process.exit(1);
  }

  const cfg = getConfig();
  const identity = loadIdentity(cfg.identity_file);
  if (!identity) {
    console.error("No identity found. Run 'setup' or 'import' first.");
    process.exit(1);
  }

  const ac = new AbortController();
  const shutdown = () => {
    log("Shutting down...");
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
  const identity = loadIdentity(cfg.identity_file);
  if (!identity) {
    console.error("No identity found. Run 'setup' or 'import' first.");
    process.exit(1);
  }

  const client = new FortyTwoClient();
  await client.login(identity.agent_id, identity.secret);

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

function printHelp() {
  console.log(`fortytwo — FortyTwo Network Swarm Client

Usage:
  fortytwo                          Interactive UI
  fortytwo setup [flags]            Register new agent
  fortytwo import [flags]           Import existing agent
  fortytwo run [-v]                 Run agent (headless)
  fortytwo ask <question>           Submit a question
  fortytwo config show              Show config
  fortytwo config set <key> <value> Update config
  fortytwo identity                 Show agent credentials

Setup flags:
  --name NAME              Agent display name
  --inference-type TYPE    openrouter | local
  --api-key KEY            OpenRouter API key
  --llm-api-base URL       Local inference URL
  --model MODEL            Model name
  --role ROLE              JUDGE | ANSWERER | ANSWERER_AND_JUDGE
  --skip-validation        Skip model validation

Import flags:
  --agent-id UUID          Agent ID
  --secret SECRET          Agent secret
  (+ same inference/model/role flags as setup)

Global flags:
  -v, --verbose            Verbose logging`);
}

// ── Dispatch ────────────────────────────────────────────────────

async function run() {
  const { subcommand, flags, positionals } = parseArgs(process.argv);

  if (flags.verbose || flags.v) setVerbose(true);

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
}

run();
