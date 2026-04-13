import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as config from "./config.js";
import type { FortyTwoClient } from "./api-client.js";
import type { ResetResponse } from "./api-types.js";

export type LogFn = (msg: string) => void;

export interface Identity {
  node_id: string;
  node_secret: string;
  public_key_pem?: string;
  private_key_pem?: string;
}

export function generateRsaKeypair(): { privatePem: string; publicPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privatePem: privateKey as string, publicPem: publicKey as string };
}

export function saveIdentity(path: string, identity: Identity): void {
  writeFileSync(path, JSON.stringify(identity, null, 2));
}

export function loadIdentity(path: string): Identity | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));

    if (data.agent_id && !data.node_id) data.node_id = data.agent_id;
    if (data.secret && !data.node_secret) data.node_secret = data.secret;
    if (data.node_id && data.node_secret) return data as Identity;
    return null;
  } catch {
    return null;
  }
}

/**
 * Register a new agent using the 1-step registration flow (TZ-001).
 * The server returns `agent_id`, `secret`, `capability_rank` (0) and
 * `node_tier` ("challenger") directly — no pairwise challenge quiz.
 */
export async function registerAgent(
  client: FortyTwoClient,
  displayName = "JudgeNode",
  log: LogFn = console.log,
): Promise<Identity> {
  log(`Registering "${displayName}"...`);

  const { privatePem, publicPem } = generateRsaKeypair();
  const response = await client.register(publicPem, displayName);

  if (!response?.agent_id || !response?.secret) {
    throw new Error(
      `Registration failed — server did not return agent_id/secret (got keys: ${
        response ? Object.keys(response).join(", ") : "none"
      }). The server may be running the legacy 2-step flow; check fortytwo_api_base.`,
    );
  }

  const identity: Identity = {
    node_id: response.agent_id,
    node_secret: response.secret,
    public_key_pem: publicPem,
    private_key_pem: privatePem,
  };
  saveIdentity(config.get().node_identity_file, identity);
  log(`✓ Registered — Node ID: ${response.agent_id} (tier: ${response.node_tier}, rank: ${response.capability_rank})`);

  return identity;
}

/**
 * Reset the node's capability rank. The server performs a one-shot reset
 * (no challenge quiz) and drops FOR into `challenge_locked`.
 */
export async function resetAccount(
  client: FortyTwoClient,
  log: LogFn = console.log,
): Promise<ResetResponse> {
  log(`↳ Resetting capability...`);
  const result = await client.resetCapability();
  log(`✓ Reset complete — rank ${result.rank_before} → 0, +${result.drop_amount} FOR locked`);
  return result;
}
