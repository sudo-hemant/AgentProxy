import { type ExtensionConfig, parseExtensionConfig } from "@agentproxy/shared";

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
  return parseExtensionConfig(data);
}
