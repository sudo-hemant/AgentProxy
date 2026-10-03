import { DEFAULT_PORT, type ExtensionConfig } from "@agentproxy/shared";

/**
 * Reads how to reach the server from `config.json` in the extension's folder. Returns undefined
 * when the file is missing or unusable: the extension then has no server to connect to.
 */
export async function loadConfig(
  fetchFile: (url: string) => Promise<Response>,
  fileUrl: string,
): Promise<ExtensionConfig | undefined> {
  let data: unknown;
  try {
    const response = await fetchFile(fileUrl);
    if (!response.ok) return undefined;
    data = await response.json();
  } catch {
    return undefined; // missing file or not JSON
  }
  return parseConfig(data);
}

function parseConfig(data: unknown): ExtensionConfig | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { port = DEFAULT_PORT, token } = data as { port?: unknown; token?: unknown };
  if (typeof token !== "string" || token === "") return undefined;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535)
    return undefined;
  return { port: port as number, token };
}
