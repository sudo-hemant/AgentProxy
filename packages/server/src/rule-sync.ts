import { type MockRule, parseExtensionToServer, type ServerToExtension } from "@agentproxy/shared";

/** The part of a `ws` WebSocket the rule sync uses, so tests can pass a fake. */
export interface ExtensionSocket {
  send(data: string): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

export interface SetRulesResult {
  version: number;
  /** Whether the extension confirmed this version (or a newer one) before the timeout. */
  applied: boolean;
}

export interface RuleSync {
  /** Starts syncing with a newly connected extension: it gets the current rules right away. */
  attach(socket: ExtensionSocket): void;
  /** Replaces the rules, sends them to the extension, and waits for it to confirm them. */
  setRules(rules: MockRule[]): Promise<SetRulesResult>;
  getRules(): MockRule[];
}

export const DEFAULT_ACK_TIMEOUT_MS = 5000;

interface Waiter {
  version: number;
  resolve(result: SetRulesResult): void;
  timer: NodeJS.Timeout;
}

/** Keeps the extension's rules in step with the server's: the server's list is the truth. */
export function createRuleSync({ ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS } = {}): RuleSync {
  let rules: MockRule[] = [];
  let version = 0;
  let socket: ExtensionSocket | undefined;
  const waiters = new Set<Waiter>();

  const sendRules = (to: ExtensionSocket) => {
    const message: ServerToExtension = { type: "rules", version, rules };
    to.send(JSON.stringify(message));
  };

  /** A confirmed version also settles older ones: each rule list replaces the one before. */
  const confirm = (applied: number) => {
    for (const waiter of waiters) {
      if (waiter.version > applied) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve({ version: waiter.version, applied: true });
    }
  };

  return {
    attach(next) {
      socket = next;
      next.on("message", (data) => {
        const message = parseExtensionToServer(String(data));
        if (message?.type === "applied") confirm(message.version);
      });
      next.on("close", () => {
        if (socket === next) socket = undefined;
      });
      sendRules(next);
    },

    setRules(next) {
      rules = next;
      version += 1;
      const current = version;
      if (!socket) return Promise.resolve({ version: current, applied: false });
      sendRules(socket);
      return new Promise((resolve) => {
        const waiter: Waiter = {
          version: current,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            resolve({ version: current, applied: false });
          }, ackTimeoutMs),
        };
        waiters.add(waiter);
      });
    },

    getRules: () => rules,
  };
}
