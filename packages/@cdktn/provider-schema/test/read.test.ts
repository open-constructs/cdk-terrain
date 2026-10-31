/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import {
  ConstructsMakerProviderTarget,
  Language,
  TerraformProviderConstraint,
  withTempDir,
} from "@cdktn/commons";
import { readSchema } from "../";
import { getFetchingCliVersion } from "../src/provider-schema";
import * as fs from "fs-extra";
import * as path from "path";

describe("read", () => {
  describe("disabled cache", () => {
    it("can generate a provider schema", async () => {
      const schema = await readSchema([
        new ConstructsMakerProviderTarget(
          new TerraformProviderConstraint("kreuzwerker/docker@=3.9.0"),
          Language.TYPESCRIPT,
        ),
      ]);
      // Keyed by fully qualified name, and the host is whichever registry the
      // fetching CLI used, so match on the provider part.
      expect(
        Object.keys(schema.providerSchema.provider_schemas ?? {}).map((fqpn) =>
          fqpn.split("/").slice(1).join("/"),
        ),
      ).toContain("kreuzwerker/docker");
    });
  });

  describe("enabled cache", () => {
    it("can load cached value", async () => {
      await withTempDir("cache", async () => {
        const cached = { my: "schema" };
        // The cache key carries a <cli>-<major>.<minor> suffix so a schema
        // fetched by a CLI too old to emit newer sections is not served as a
        // complete one. Build it the way the product does rather than pinning
        // a literal, which also keeps this working under either CLI.
        const cli = await getFetchingCliVersion();
        const [major, minor] = (cli.version ?? "").split(".");
        const cacheKey = `kreuzwerker%2Fdocker@%3D3.9.0@${encodeURIComponent(
          `${cli.name}-${major}.${minor}`,
        )}`;
        await fs.writeFile(
          path.join(process.cwd(), `${cacheKey}.json`),
          JSON.stringify(cached),
        );

        const schema = await readSchema(
          [
            new ConstructsMakerProviderTarget(
              new TerraformProviderConstraint("kreuzwerker/docker@=3.9.0"),
              Language.TYPESCRIPT,
            ),
          ],
          process.cwd(),
        );
        expect(schema).toEqual({
          moduleSchema: {},
          providerSchema: { format_version: "0.1", ...cached },
        });
      });
    });
  });
});
