// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import * as path from "path";
import { TerraformProviderGenerator } from "../../generator/provider-generator";
import { CodeMaker } from "codemaker";
import { createTmpHelper } from "../util";

const tmp = createTmpHelper();

// Terraform's JSON syntax requires every non-optional key of an object type to
// be present, so an unset key must be emitted as null rather than omitted
// (issue #528: new aws_route_table.route targets failed `terraform validate`).
describe("null defaults for object-typed attribute keys", () => {
  let output: string;

  beforeAll(async () => {
    const code = new CodeMaker();
    const workdir = tmp("object-type-null-defaults.test");
    const spec = JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          "fixtures",
          "object-type-null-defaults.test.fixture.json",
        ),
        "utf-8",
      ),
    );
    new TerraformProviderGenerator(code, spec).generateAll();
    await code.save(workdir);
    output = fs.readFileSync(
      path.join(workdir, "providers/example/route-table/index.ts"),
      "utf-8",
    );
  });

  test("every key of set(object) is emitted as null when unset", () => {
    for (const [key, name] of [
      ["cidr_block", "cidrBlock"],
      ["gateway_id", "gatewayId"],
      ["odb_network_arn", "odbNetworkArn"],
    ]) {
      expect(output).toContain(
        `${key}: struct!.${name} === undefined ? null : cdktn.stringToTerraform(struct!.${name}),`,
      );
      expect(output).toContain(
        `value: struct!.${name} === undefined ? null : cdktn.stringToHclTerraform(struct!.${name}),`,
      );
    }
  });

  test("keys listed as optional in the object type get no null default", () => {
    expect(output).toContain(
      "mode: struct!.mode === undefined ? null : cdktn.stringToTerraform(struct!.mode),",
    );
    expect(output).toContain(
      "timeout: cdktn.numberToTerraform(struct!.timeout),",
    );
    expect(output).toContain(
      "value: cdktn.numberToHclTerraform(struct!.timeout),",
    );
  });

  test("nested_type attributes get no null default", () => {
    expect(output).toContain("name: cdktn.stringToTerraform(struct!.name),");
    expect(output).toContain(
      "value: cdktn.stringToHclTerraform(struct!.name),",
    );
  });
});
