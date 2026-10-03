import { resolve } from "node:path";
import { DEFAULT_PORT } from "@agentproxy/shared";

export interface Settings {
  port: number;
  /** Set only to force a token; otherwise the pairing's token (or a new one) is used. */
  token?: string;
  /** The extension folder to write the pairing into. */
  extensionDir: string;
}

/**
 * Reads the server's settings from the environment:
 * - `AGENTPROXY_PORT`: where the extension connects. Default 47821; 0 picks a free port.
 * - `AGENTPROXY_TOKEN`: forces the pairing token. Normally unset.
 * - `AGENTPROXY_EXTENSION_DIR`: the extension folder. Default `defaultExtensionDir`.
 * Throws with a readable message when a value is unusable.
 */
export function readSettings(env: NodeJS.ProcessEnv, defaultExtensionDir: string): Settings {
  return {
    port: readPort(env.AGENTPROXY_PORT),
    token: env.AGENTPROXY_TOKEN || undefined,
    extensionDir: resolve(env.AGENTPROXY_EXTENSION_DIR || defaultExtensionDir),
  };
}

function readPort(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PORT;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65_535) {
    throw new Error(`AGENTPROXY_PORT must be a port number from 0 to 65535, got "${value}"`);
  }
  return port;
}
