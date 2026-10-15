/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { noColorDefault } from "../color";

describe("noColorDefault", () => {
  it("keeps color on in a terminal", () => {
    expect(noColorDefault({}, true)).toBe(false);
  });

  it("turns color off when stdout is piped or redirected", () => {
    expect(noColorDefault({}, false)).toBe(true);
    expect(noColorDefault({}, undefined)).toBe(true);
  });

  it("turns color off for FORCE_COLOR=0 even in a terminal", () => {
    expect(noColorDefault({ FORCE_COLOR: "0" }, true)).toBe(true);
  });

  it("keeps color on for piped output when FORCE_COLOR asks for it", () => {
    expect(noColorDefault({ FORCE_COLOR: "1" }, false)).toBe(false);
    expect(noColorDefault({ FORCE_COLOR: "true" }, false)).toBe(false);
  });
});
