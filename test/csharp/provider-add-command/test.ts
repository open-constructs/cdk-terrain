// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import {
  onPosix,
  TestDriver,
  onWindows,
  sanitizeTimestamps,
} from "../../test-helper";

describe("provider add command", () => {
  describe("pre-built", () => {
    let driver: TestDriver;
    beforeEach(async () => {
      driver = new TestDriver(__dirname, {
        DISABLE_VERSION_CHECK: "true",
      }); // reset CDKTF_DIST set by run-against-dist script & disable version check as we have to use an older version of cdktn-clie
      await driver.setupCsharpProject();

      await driver.exec("dotnet", [
        "add",
        "package",
        "Io.Cdktn",
        "--version",
        "0.23.1",
      ]);
    }, 500_000);

    it("detects correct cdktn version", async () => {
      const res = await driver.exec("cdktn", ["debug"]);
      expect(res.stdout).toContain("cdktn: 0.23.1");
    });

    onPosix(
      "installs pre-built provider using nuget",
      async () => {
        const res = await driver.exec("cdktn", [
          "provider",
          "add",
          "random@=3.9.0",
        ]);
        expect(sanitizeTimestamps(res.stdout)).toMatchInlineSnapshot(`
          "[<TIMESTAMP>] [INFO] default - Checking whether pre-built provider exists for the following constraints:
            provider: random
            version : =3.9.0
            language: csharp
            cdktn   : 0.23.1


          [<TIMESTAMP>] [INFO] default - Found pre-built provider.

          Installing package Io.Cdktn.Providers.Random @ 14.1.0 using "dotnet add package Io.Cdktn.Providers.Random --version 14.1.0".

          Package installed.
          "
        `);
        expect(res.stderr).toBe("");

        const proj = driver.readLocalFile("MyTerraformStack.csproj");

        expect(proj).toContain(
          '<PackageReference Include="Io.Cdktn.Providers.Random" Version="14.1.0" />',
        );
      },
      500_000,
    );

    onWindows(
      "installs pre-built provider using nuget",
      async () => {
        const res = await driver.exec("cdktn", [
          "provider",
          "add",
          "random@=3.9.0",
        ]);
        expect(sanitizeTimestamps(res.stdout)).toMatchInlineSnapshot(`
                  "[<TIMESTAMP>] [INFO] default - Checking whether pre-built provider exists for the following constraints:
                    provider: random
                    version : =3.9.0
                    language: csharp
                    cdktn   : 0.23.1


                  [<TIMESTAMP>] [INFO] default - Found pre-built provider.

                  Installing package Io.Cdktn.Providers.Random @ 14.1.0 using "dotnet add package Io.Cdktn.Providers.Random --version 14.1.0".

                  Package installed.
                  "
              `);
        expect(res.stderr).toBe("");

        const proj = driver.readLocalFile("MyTerraformStack.csproj");

        expect(proj).toContain(
          '<PackageReference Include="Io.Cdktn.Providers.Random" Version="14.1.0" />',
        );
      },
      500_000,
    );
  });
});
