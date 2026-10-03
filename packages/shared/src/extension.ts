// Where the extension and the server find each other.

/**
 * The extension's ID. Fixed by the public `key` in the extension's manifest, so it is the same on
 * every machine and the server can accept exactly this extension.
 */
export const EXTENSION_ID = "hidhibepbghhdfljdadfhcgkgjngeocm";

/** The only Origin the server accepts a WebSocket from. */
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

/** The port the server listens on unless told otherwise. */
export const DEFAULT_PORT = 47821;

/** Written next to the extension's manifest: tells the extension how to reach the server. */
export interface ExtensionConfig {
  port: number;
  /** The pairing token the server expects. */
  token: string;
}

/** The file name of the `ExtensionConfig`, in the extension's folder. */
export const EXTENSION_CONFIG_FILE = "config.json";

/** Checks parsed `config.json` contents. Returns undefined when they are unusable. */
export function parseExtensionConfig(data: unknown): ExtensionConfig | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { port = DEFAULT_PORT, token } = data as { port?: unknown; token?: unknown };
  if (typeof token !== "string" || token === "") return undefined;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    return undefined;
  }
  return { port: port as number, token };
}
