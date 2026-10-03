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
