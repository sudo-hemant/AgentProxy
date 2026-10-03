import { randomBytes } from "node:crypto";
import { DEFAULT_PORT } from "@agentproxy/shared";

export interface Settings {
  port: number;
  token: string;
}

/**
 * Reads the server's settings from the environment:
 * - `AGENTPROXY_PORT`: where the extension connects. Default 47821; 0 picks a free port.
 * - `AGENTPROXY_TOKEN`: the pairing token. A random one for this run if unset.
 * Throws with a readable message when a value is unusable.
 */
export function readSettings(env: NodeJS.ProcessEnv): Settings {
  return { port: readPort(env.AGENTPROXY_PORT), token: env.AGENTPROXY_TOKEN || randomToken() };
}

function readPort(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PORT;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65_535) {
    throw new Error(`AGENTPROXY_PORT must be a port number from 0 to 65535, got "${value}"`);
  }
  return port;
}

function randomToken(): string {
  return randomBytes(16).toString("hex");
}
