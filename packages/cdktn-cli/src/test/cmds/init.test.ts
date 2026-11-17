// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import execa from "execa";
import path from "path";
import { mkdtemp } from "@cdktn/commons";
import { describeIfDistExists } from "@cdktn/cli-core/src/test/test-helpers";
import cdktnCliPkg from "../../../package.json";

const cdktnCliRoot = path.resolve(__dirname, "../../..");
const cdktfBin = path.resolve(cdktnCliRoot, cdktnCliPkg.bin.cdktn);
const cdktfDist = path.join(__dirname, "../../../../../dist");

describeIfDistExists(__dirname)("init command", () => {
  it("accepts no as a reasonable answer to using remote terraform", async () => {
    await mkdtemp(async (cwd) => {
      const input = "n\n";
      const result = await execa(
        cdktfBin,
        [
          "init",
          `--dist=${cdktfDist}`,
          "--template=typescript",
          "--project-name=test",
          "--project-description=foo",
          "--from-terraform-project=false",
          "--enable-crash-reporting=false",
        ],
        {
          stdio: "pipe",
          cwd,
          input,
        },
      );
      // stderr may only contain npm warnings
      const unexpectedStderr = result.stderr
        .split("\n")
        .filter(
          (line) => line.length > 0 && !line.toLowerCase().includes("npm warn"),
        );
      expect(unexpectedStderr).toEqual([]);

      expect(result.stdout).not.toContain(
        `opening webpage using your browser.`,
      );
      expect(result.stdout).not.toContain(`Detected Terraform Cloud token.`);
    });
  }, 30_000);
});
