// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { templateTelemetryName } from "../init";

describe("templateTelemetryName", () => {
  it.each([
    ["typescript", "typescript"],
    ["python", "python"],
    ["https://example.com/my-secret-template", "remote"],
    ["my-secret-template", "remote"],
  ])("maps the template %p to %p", (name, expected) => {
    expect(templateTelemetryName(name)).toBe(expected);
  });
});
