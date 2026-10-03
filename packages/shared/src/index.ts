/** Protocol version shared by the server and the extension. Bumped when their messages change. */
export const PROTOCOL_VERSION = 1;

export * from "./bridge-protocol.js";
export * from "./extension.js";
export * from "./matcher.js";
export * from "./messages.js";
export type * from "./rule.js";
