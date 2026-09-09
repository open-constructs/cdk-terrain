// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { SynthStack, SynthesizedStack } from "../../lib/synth-stack";

function stack(content: string): SynthesizedStack {
  return {
    name: "stack",
    dependencies: [],
    annotations: [],
    content,
    constructPath: ".",
    synthesizedStackPath: ".",
    workingDirectory: ".",
    stackMetadataPath: ".",
  };
}

describe("SynthStack.telemetryPayload", () => {
  it("extracts the metadata block and required providers per stack", () => {
    const metadata = { version: "0.21.0", backend: "local" };
    const requiredProviders = { aws: { source: "aws", version: "~> 5.0" } };
    const payload = SynthStack.telemetryPayload([
      stack(
        JSON.stringify({
          "//": { metadata, outputs: {} },
          terraform: { required_providers: requiredProviders },
          resource: { aws_s3_bucket: { bucket: { bucket: "name" } } },
        }),
      ),
      // HCL output: the content is the metadata file, without a terraform block
      stack(JSON.stringify({ "//": { metadata, outputs: {} } })),
    ]);

    expect(payload).toEqual({
      stackMetadata: [metadata, metadata],
      requiredProviders: [requiredProviders, {}],
    });
    expect(JSON.stringify(payload)).not.toContain("aws_s3_bucket");
  });

  it("yields empty entries for content without metadata or unparsable content", () => {
    expect(
      SynthStack.telemetryPayload([stack("{}"), stack("not json")]),
    ).toEqual({
      stackMetadata: [{}, {}],
      requiredProviders: [{}, {}],
    });
  });
});
