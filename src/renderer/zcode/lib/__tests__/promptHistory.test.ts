import { describe, expect, it } from "vitest";
import { appendPromptHistoryEntry, navigatePromptHistory } from "../promptHistory";

describe("appendPromptHistoryEntry", () => {
  it("trims, skips empty and consecutive duplicates, and caps length", () => {
    expect(appendPromptHistoryEntry([], "  a  ")).toEqual(["a"]);
    expect(appendPromptHistoryEntry(["a"], "   ")).toEqual(["a"]);
    expect(appendPromptHistoryEntry(["a"], "a ")).toEqual(["a"]);
    expect(appendPromptHistoryEntry(["a", "b"], "a")).toEqual(["a", "b", "a"]);
    expect(appendPromptHistoryEntry(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
  });
});

describe("navigatePromptHistory", () => {
  const entries = ["first", "second", "third"];

  it("does nothing without history", () => {
    expect(navigatePromptHistory([], null, "up").shouldHandle).toBe(false);
  });

  it("walks up to the oldest entry and stays there", () => {
    expect(navigatePromptHistory(entries, null, "up")).toEqual({ nextIndex: 2, nextValue: "third", shouldHandle: true });
    expect(navigatePromptHistory(entries, 2, "up").nextValue).toBe("second");
    expect(navigatePromptHistory(entries, 0, "up")).toEqual({ nextIndex: 0, nextValue: "first", shouldHandle: true });
  });

  it("walks down and leaves history browsing past the newest entry", () => {
    expect(navigatePromptHistory(entries, 0, "down").nextValue).toBe("second");
    expect(navigatePromptHistory(entries, 2, "down")).toEqual({ nextIndex: null, nextValue: "", shouldHandle: true });
  });
});
