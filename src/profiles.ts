import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, setConfigDir, reloadConfig } from "./config.js";
import { loadIdentity, type Identity } from "./identity.js";
import type { UserConfig } from "./config.js";

export const PROFILES_DIR = join(CONFIG_DIR, "profiles");
export const PROFILES_META = join(CONFIG_DIR, "profiles.json");

export interface ProfilesMeta {
  active: string;
  profiles: string[];
}

export interface ProfileInfo {
  name: string;
  active: boolean;
  agentName: string;
  agentId: string;
}

let _profileOverride: string | undefined;

export function setProfileOverride(name: string | undefined): void {
  _profileOverride = name;
}

export function sanitizeProfileName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "default";
}

export function loadProfilesMeta(): ProfilesMeta | null {
  if (!existsSync(PROFILES_META)) return null;
  try {
    return JSON.parse(readFileSync(PROFILES_META, "utf-8")) as ProfilesMeta;
  } catch {
    return null;
  }
}

export function saveProfilesMeta(meta: ProfilesMeta): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PROFILES_META, JSON.stringify(meta, null, 2));
}

export function getActiveProfileName(): string {
  if (_profileOverride) return _profileOverride;

  const env = process.env.FORTYTWO_PROFILE;
  if (env) return env;

  const meta = loadProfilesMeta();
  return meta?.active ?? "default";
}

export function getProfileDir(name?: string): string {
  const profileName = name ?? getActiveProfileName();
  return join(PROFILES_DIR, profileName);
}

export function initProfiles(): void {
  migrateIfNeeded();
  const dir = getProfileDir();
  setConfigDir(dir);
  reloadConfig();
}

export function profileExists(name: string): boolean {
  const dir = getProfileDir(name);
  return existsSync(join(dir, "config.json"));
}

export function listProfiles(): ProfileInfo[] {
  const meta = loadProfilesMeta();
  if (!meta || meta.profiles.length === 0) return [];

  const activeName = getActiveProfileName();

  return meta.profiles.map((name) => {
    const dir = getProfileDir(name);
    let agentName = name;
    let agentId = "";

    try {
      const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"));
      agentName = cfg.agent_name || cfg.display_name || name;
    } catch {}

    try {
      const id = loadIdentity(join(dir, "identity.json"));
      if (id) agentId = id.agent_id;
    } catch {}

    return { name, active: name === activeName, agentName, agentId };
  });
}

export function createProfile(name: string, cfg: UserConfig, identity?: Identity): void {
  const dir = getProfileDir(name);
  mkdirSync(dir, { recursive: true });

  const profileCfg = { ...cfg, identity_file: join(dir, "identity.json") };
  writeFileSync(join(dir, "config.json"), JSON.stringify(profileCfg, null, 2));

  if (identity) {
    writeFileSync(join(dir, "identity.json"), JSON.stringify(identity, null, 2));
  }

  const meta = loadProfilesMeta() ?? { active: name, profiles: [] };
  if (!meta.profiles.includes(name)) {
    meta.profiles.push(name);
  }
  meta.active = name;
  saveProfilesMeta(meta);

  setConfigDir(dir);
  reloadConfig();
}

export function deleteProfile(name: string): void {
  const meta = loadProfilesMeta();
  if (!meta) throw new Error("No profiles found.");
  if (meta.active === name) throw new Error("Cannot delete the active profile. Switch first.");
  if (!meta.profiles.includes(name)) throw new Error(`Profile "${name}" not found.`);

  const dir = getProfileDir(name);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }

  meta.profiles = meta.profiles.filter((p) => p !== name);
  saveProfilesMeta(meta);
}

export function switchProfile(name: string): void {
  const meta = loadProfilesMeta();
  if (!meta) throw new Error("No profiles found.");
  if (!meta.profiles.includes(name)) {
    const available = meta.profiles.join(", ");
    throw new Error(`Profile "${name}" not found. Available: ${available}`);
  }

  meta.active = name;
  saveProfilesMeta(meta);

  setConfigDir(getProfileDir(name));
  reloadConfig();
}

const LEGACY_CONFIG = join(CONFIG_DIR, "config.json");
const LEGACY_IDENTITY = join(CONFIG_DIR, "identity.json");

export function migrateIfNeeded(): void {
  if (existsSync(PROFILES_META)) return;

  if (!existsSync(LEGACY_CONFIG)) {
    saveProfilesMeta({ active: "default", profiles: [] });
    return;
  }

  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(readFileSync(LEGACY_CONFIG, "utf-8"));
  } catch {
    saveProfilesMeta({ active: "default", profiles: [] });
    return;
  }

  const agentName = (cfg.agent_name as string) || (cfg.display_name as string) || "";
  const profileName = sanitizeProfileName(agentName) || "default";
  const dir = join(PROFILES_DIR, profileName);
  mkdirSync(dir, { recursive: true });

  const profileCfg = { ...cfg, identity_file: join(dir, "identity.json") };
  writeFileSync(join(dir, "config.json"), JSON.stringify(profileCfg, null, 2));

  const legacyIdentityPath = (cfg.identity_file as string) || LEGACY_IDENTITY;
  if (existsSync(legacyIdentityPath)) {
    try {
      const identityData = readFileSync(legacyIdentityPath, "utf-8");
      writeFileSync(join(dir, "identity.json"), identityData);
    } catch {}
  }

  saveProfilesMeta({ active: profileName, profiles: [profileName] });
}
