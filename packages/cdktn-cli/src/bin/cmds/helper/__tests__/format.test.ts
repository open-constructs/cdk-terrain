// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import stripAnsi from "strip-ansi";
import {
  formatLogLine,
  renderExecution,
  renderOutputs,
  renderProviderTable,
  renderStackList,
  renderWatchStatus,
} from "../format";

describe("formatLogLine", () => {
  it("prefixes content with the (coloured) stack name", () => {
    const out = stripAnsi(
      formatLogLine({ stackName: "alpha", content: " hi " }),
    );
    expect(out).toBe("alpha  hi");
  });
});

describe("renderOutputs", () => {
  const leaf = (value: any, sensitive = false) => ({
    sensitive,
    type: "string",
    value,
  });

  it("renders a single leaf output", () => {
    expect(renderOutputs({ name: leaf("hello") as any })).toBe("name = hello");
  });

  it("redacts sensitive outputs", () => {
    expect(renderOutputs({ secret: leaf("password123", true) as any })).toBe(
      "secret = <sensitive>",
    );
  });

  it("formats object values as pretty JSON", () => {
    const out = renderOutputs({ obj: leaf({ a: 1, b: [2, 3] }) as any });
    expect(out).toContain("obj = {");
    expect(out).toContain('"a": 1');
    expect(out).toContain('"b": [');
  });

  it("renders nested groups with the group name bolded and children indented", () => {
    const out = stripAnsi(
      renderOutputs({
        stack: {
          host: leaf("example.com") as any,
          port: leaf(443) as any,
        } as any,
      }),
    );
    expect(out).toContain("stack");
    expect(out).toContain("  host = example.com");
    expect(out).toContain("  port = 443");
  });
});

describe("renderProviderTable", () => {
  it("returns empty string for an empty data set", () => {
    expect(renderProviderTable([])).toBe("");
  });

  it("renders the provided rows with column headers and values", () => {
    const out = stripAnsi(
      renderProviderTable([
        {
          "Provider Name": "random",
          "Provider Version": "3.1.3",
          CDKTF: "",
          CDKTN: "",
          Constraint: "=3.1.3",
          "Package Name": "",
          "Package Version": "",
        },
      ]),
    );
    expect(out).toContain("Provider");
    expect(out).toContain("Name");
    expect(out).toContain("random");
    expect(out).toContain("3.1.3");
    expect(out).toContain("=3.1.3");
  });

  it("renders missing values as empty cells (no 'undefined' leak)", () => {
    const out = stripAnsi(
      renderProviderTable([
        { "Provider Name": "tfe", "Provider Version": "0.74.1" } as any,
      ]),
    );
    expect(out).not.toContain("undefined");
    expect(out).toContain("tfe");
  });
});

describe("renderStackList", () => {
  it("includes header and rows with the working directory", () => {
    const out = stripAnsi(
      renderStackList([
        { name: "first", workingDirectory: "cdktf.out/stacks/first" },
        { name: "second", workingDirectory: "cdktf.out/stacks/second" },
      ]),
    );
    expect(out).toMatch(/Stack name\s+Path/);
    expect(out).toContain("first");
    expect(out).toContain("second");
    expect(out).toContain("cdktf.out/stacks/first");
    expect(out).toContain("cdktf.out/stacks/second");
  });
});

describe("renderExecution", () => {
  it("pluralises 1 Stack vs N Stacks correctly", () => {
    const one = renderExecution([{} as any], [], [], "deploying");
    expect(one).toContain("1 Stack deploying");
    const many = renderExecution(
      [{} as any, {} as any],
      [{} as any, {} as any, {} as any],
      [],
      "deploying",
    );
    expect(many).toContain("2 Stacks deploying");
    expect(many).toContain("3 Stacks done");
    expect(many).toContain("0 Stacks waiting");
  });
});

describe("renderWatchStatus", () => {
  it("returns spinner=true for waiting/empty-running and false for running-with-stacks/stopped", () => {
    expect(renderWatchStatus({ type: "waiting" } as any)).toEqual({
      text: "Waiting for changes...",
      spinner: true,
    });
    expect(renderWatchStatus({ type: "stopped" } as any)).toEqual({
      text: "Watch was stopped",
      spinner: false,
    });
    expect(
      renderWatchStatus({
        type: "running",
        inProgress: [],
        finished: [],
        pending: [],
      } as any),
    ).toEqual({ text: "Synthesizing...", spinner: true });
    const active = renderWatchStatus({
      type: "running",
      inProgress: [{}],
      finished: [],
      pending: [],
    } as any);
    expect(active.spinner).toBe(false);
    expect(active.text).toContain("1 Stack deploying");
  });
});
