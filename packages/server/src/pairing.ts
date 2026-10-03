import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EXTENSION_CONFIG_FILE,
  type ExtensionConfig,
  parseExtensionConfig,
} from "@agentproxy/shared";

// Pairing for an extension loaded from a local folder: the server writes the port and token into
// the extension's config.json, and reads the token back on every start, so restarting the server
// never breaks the pairing.

/** The pairing in the extension folder, or undefined if there is none or it is unusable. */
export async function readPairing(extensionDir: string): Promise<ExtensionConfig | undefined> {
  try {
    return parseExtensionConfig(JSON.parse(await readFile(configPath(extensionDir), "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * Writes the pairing into the extension folder, unless it already holds exactly this one.
 * Returns whether the file changed. Throws if the folder can't be written, e.g. doesn't exist.
 */
export async function writePairing(
  extensionDir: string,
  config: ExtensionConfig,
): Promise<boolean> {
  const current = await readPairing(extensionDir);
  if (current?.port === config.port && current.token === config.token) return false;
  const content: ExtensionConfig = { port: config.port, token: config.token };
  await writeFile(configPath(extensionDir), `${JSON.stringify(content, null, 2)}\n`);
  return true;
}

export function configPath(extensionDir: string): string {
  return join(extensionDir, EXTENSION_CONFIG_FILE);
}
