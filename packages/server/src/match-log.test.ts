import type { MatchReport } from "@agentproxy/shared";
import { describe, expect, it } from "vitest";
import { createMatchLog } from "./match-log.js";

const match = (ruleId: string, n = 1): MatchReport => ({
  ruleId,
  method: "GET",
  url: `http://localhost:3000/api/${n}`,
  transport: "fetch",
});

/** A log whose clock the test moves by hand. */
function setup(max?: number) {
  let time = 0;
  const log = createMatchLog({ now: () => time, max });
  return { log, setTime: (t: number) => (time = t) };
}

describe("createMatchLog", () => {
  it("starts empty", () => {
    expect(setup().log.query()).toEqual([]);
  });

  it("records each match with the time it arrived, oldest first", () => {
    const { log, setTime } = setup();
    setTime(100);
    log.record(match("a"));
    setTime(200);
    log.record(match("b"));
    expect(log.query()).toEqual([
      { ...match("a"), at: 100 },
      { ...match("b"), at: 200 },
    ]);
  });

  describe("query", () => {
    it("filters by mock id", () => {
      const { log } = setup();
      log.record(match("a"));
      log.record(match("b"));
      log.record(match("a", 2));
      expect(log.query({ ruleId: "a" }).map((m) => m.url)).toEqual([
        "http://localhost:3000/api/1",
        "http://localhost:3000/api/2",
      ]);
    });

    it("filters by time, including the given moment", () => {
      const { log, setTime } = setup();
      for (const t of [100, 200, 300]) {
        setTime(t);
        log.record(match("a"));
      }
      expect(log.query({ since: 200 }).map((m) => m.at)).toEqual([200, 300]);
    });

    it("combines both filters", () => {
      const { log, setTime } = setup();
      setTime(100);
      log.record(match("a"));
      setTime(200);
      log.record(match("b"));
      log.record(match("a"));
      expect(log.query({ ruleId: "a", since: 150 })).toEqual([{ ...match("a"), at: 200 }]);
    });
  });

  it("keeps only the most recent entries", () => {
    const { log } = setup(3);
    for (let n = 1; n <= 5; n++) log.record(match("a", n));
    expect(log.query().map((m) => m.url)).toEqual([
      "http://localhost:3000/api/3",
      "http://localhost:3000/api/4",
      "http://localhost:3000/api/5",
    ]);
  });

  it("keeps 500 by default", () => {
    const { log } = setup();
    for (let n = 0; n < 505; n++) log.record(match("a", n));
    expect(log.query()).toHaveLength(500);
  });
});
