// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { onPosix, TestDriver, onWindows } from "../../test-helper";

describe("provider upgrade command", () => {
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

    onPosix(
      "installs pre-built provider using nuget",
      async () => {
        await driver.exec("cdktn", [
          "provider",
          "add",
          "random@=3.7.2",
        ]);

        expect(driver.readLocalFile("MyTerraformStack.csproj")).toContain(
          '<PackageReference Include="Io.Cdktn.Providers.Random" Version="12.1.0" />',
        );

        await driver.exec("cdktn", ["provider", "upgrade", "random@=3.8.1"]);

        expect(driver.readLocalFile("MyTerraformStack.csproj")).not.toContain(
          '<PackageReference Include="Io.Cdktn.Providers.Random" Version="12.1.0" />',
        );
        expect(driver.readLocalFile("MyTerraformStack.csproj")).toContain(
          '<PackageReference Include="Io.Cdktn.Providers.Random" Version="12.1.1" />',
        );
      },
      500_000,
    );

    onWindows(
      "installs pre-built provider using nuget",
      async () => {
        await driver.exec("cdktn", [
          "provider",
          "add",
          "random@=3.7.2",
        ]);

        expect(driver.readLocalFile("MyTerraformStack.csproj")).toContain(
          '<PackageReference Include="Io.Cdktn.Providers.Random" Version="12.1.0" />',
        );

        await driver.exec("cdktn", ["provider", "upgrade", "random@=3.8.1"]);

        expect(driver.readLocalFile("MyTerraformStack.csproj")).not.toContain(
          '<PackageReference Include="Io.Cdktn.Providers.Random" Version="12.1.0" />',
        );
        expect(driver.readLocalFile("MyTerraformStack.csproj")).toContain(
          '<PackageReference Include="Io.Cdktn.Providers.Random" Version="12.1.1" />',
        );
      },
      500_000,
    );
  });
});
