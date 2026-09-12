// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Errors } from "./errors";

describe("Errors scope", () => {
  afterEach(() => {
    Errors.setScope("unknown");
  });

  // the bundle has one copy of this module per entry point: the command
  // modules in bin/cdktn.js set the scope, bin/cmds/handlers.js reads it
  it("is shared with a second copy of the module", () => {
    let second: typeof Errors | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      second = require("./errors").Errors;
    });

    Errors.setScope("deploy");
    expect(second!.getScope()).toBe("deploy");

    second!.setScope("synth");
    expect(Errors.getScope()).toBe("synth");
  });
});
