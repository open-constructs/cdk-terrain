// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as path from "path";
import * as fs from "fs";
import stringify from "safe-stable-stringify";
import { TerraformStack } from "../terraform-stack";
import { IStackSynthesizer, ISynthesisSession } from "./types";
import { AnnotationMetadataEntryType, Annotations } from "../annotations";
import { ConstructOrder, IConstruct, MetadataEntry } from "constructs";
import { Aspects, IAspect } from "../aspect";
import { StackAnnotation } from "../manifest";
import { ValidateFeatureTargetSupport } from "../validations/target-versions";
import { encounteredAnnotationWithLevelError } from "../errors";

/**
 * Default stack synthesizer: invokes aspects, runs validations, collects annotations into the manifest and writes
 * the stack's Terraform configuration (JSON or HCL) to its working directory.
 */
export class StackSynthesizer implements IStackSynthesizer {
  /**
   * @param stack the stack to synthesize
   * @param continueOnErrorAnnotations if set to true, `synthesize()` will not throw an error
   * if it encounters an error Annotation. However, it will still add all errors to the manifest
   * file. The cdktn-cli uses this flag to print the errors itself.
   */
  constructor(
    protected stack: TerraformStack,
    private continueOnErrorAnnotations = false,
    private hclOutput = false,
  ) {}

  synthesize(session: ISynthesisSession) {
    invokeAspects(this.stack);

    if (!session.stacksPrepared) {
      // Sessions not built by App.synth() arrive unprepared: prepare this
      // stack so stale provider-feature and function usage is cleared and
      // rediscovered before validations run (ISynthesisSession.stacksPrepared).
      this.stack.prepareStack();
    }

    if (this.stack.hasResourceMove()) {
      this.stack.node.addValidation(
        new ValidateFeatureTargetSupport(this.stack, "The moved block", {
          terraform: ">=1.5.0",
          opentofu: ">=1.6.0",
        }),
      );
    }

    if (!session.skipValidation) {
      this.stack.runAllValidations();
    }

    const manifest = session.manifest;
    const stackManifest = manifest.forStack(this.stack);

    const workingDirectory = path.join(
      session.outdir,
      stackManifest.workingDirectory,
    );
    if (!fs.existsSync(workingDirectory)) fs.mkdirSync(workingDirectory);

    // call custom synthesis on child nodes (leafs first)
    this.stack.node
      .findAll(ConstructOrder.POSTORDER)
      .forEach((node) => getCustomSynthesis(node)?.onSynthesize(session));

    // collect Annotations into Manifest
    const annotations = this.stack.node
      .findAll()
      .map((node) => ({
        node,
        metadatas: node.node.metadata.filter(isAnnotationMetadata),
      }))
      .map<StackAnnotation[]>(({ node, metadatas }) =>
        metadatas.map((metadata) => ({
          constructPath: node.node.path,
          level: metadata.type as AnnotationMetadataEntryType,
          message: metadata.data,
          stacktrace: metadata.trace,
        })),
      )
      .reduce((list, metadatas) => [...list, ...metadatas], []); // Array.flat()

    // it is readonly but this is the place where we are allowed to write to it
    (stackManifest.annotations as any) = annotations;

    // abort if one or more error annotations have been encountered
    if (
      !this.continueOnErrorAnnotations &&
      annotations.some(isErrorAnnotation)
    ) {
      throw encounteredAnnotationWithLevelError(
        annotations
          .filter(isErrorAnnotation)
          .map((a) => `[${a.constructPath}] ${a.message}`)
          .join("\n"),
      );
    }

    if (this.hclOutput) {
      const hcl = this.stack.toHclTerraform();
      fs.writeFileSync(
        path.join(session.outdir, stackManifest.synthesizedStackPath),
        hcl.hcl,
      );

      fs.writeFileSync(
        path.join(session.outdir, stackManifest.stackMetadataPath!),
        stringify(hcl.metadata, null, 2) as string,
      );

      return;
    }

    const jsonTfConfig = this.stack.toTerraform();

    fs.writeFileSync(
      path.join(session.outdir, stackManifest.synthesizedStackPath),
      stringify(jsonTfConfig, null, 2) as string,
    );
  }
}

/**
 * Invoke aspects on the given construct tree.
 *
 * originally from https://github.com/aws/aws-cdk/blob/dcae3eead0dbf9acb1ed80ba95bb104c64cb1bd7/packages/@aws-cdk/core/lib/private/synthesis.ts#L99-L137
 */
export function invokeAspects(root: IConstruct) {
  const invokedByPath: { [nodePath: string]: IAspect[] } = {};

  let nestedAspectWarning = false;
  recurse(root, []);

  /**
   * Invokes inherited and own aspects on the construct, skipping any already invoked on it, then recurses into its
   * children
   * @param construct Construct to visit
   * @param inheritedAspects Aspects applied to the construct's ancestors
   */
  function recurse(construct: IConstruct, inheritedAspects: IAspect[]) {
    const node = construct.node;
    const aspects = Aspects.of(construct);
    const allAspectsHere = [...(inheritedAspects ?? []), ...aspects.all];
    const nodeAspectsCount = aspects.all.length;
    for (const aspect of allAspectsHere) {
      let invoked = invokedByPath[node.path];
      if (!invoked) {
        invoked = invokedByPath[node.path] = [];
      }

      if (invoked.includes(aspect)) {
        continue;
      }

      aspect.visit(construct);

      // if an aspect was added to the node while invoking another aspect it will not be invoked, emit a warning
      // the `nestedAspectWarning` flag is used to prevent the warning from being emitted for every child
      if (!nestedAspectWarning && nodeAspectsCount !== aspects.all.length) {
        Annotations.of(construct).addWarning(
          "We detected an Aspect was added via another Aspect, and will not be applied",
        );
        nestedAspectWarning = true;
      }

      // mark as invoked for this node
      invoked.push(aspect);
    }

    for (const child of construct.node.children) {
      recurse(child, allAspectsHere);
    }
  }
}

const annotationMetadataEntryTypes = [
  AnnotationMetadataEntryType.INFO,
  AnnotationMetadataEntryType.WARN,
  AnnotationMetadataEntryType.ERROR,
] as string[];

/**
 * Determines if the metadata entry is an info, warning or error annotation
 * @param metadata Metadata entry to test
 * @returns Boolean
 */
function isAnnotationMetadata(metadata: MetadataEntry): boolean {
  return annotationMetadataEntryTypes.includes(metadata.type);
}

/**
 * Determines if the annotation has error level
 * @param annotation Annotation to test
 * @returns Boolean
 */
function isErrorAnnotation(annotation: StackAnnotation): boolean {
  return annotation.level === AnnotationMetadataEntryType.ERROR;
}

// originally from https://github.com/aws/aws-cdk/blob/dcae3eead0dbf9acb1ed80ba95bb104c64cb1bd7/packages/%40aws-cdk/core/lib/private/synthesis.ts#L52
const CUSTOM_SYNTHESIS_SYM = Symbol.for("cdktf/customSynthesis");

/**
 * Interface for constructs that want to do something custom during synthesis
 *
 * This feature is intended for use by the CDKTN only; 3rd party
 * library authors and CDK users should not use this function.
 */
export interface ICustomSynthesis {
  /**
   * Called when the construct is synthesized
   */
  onSynthesize(session: ISynthesisSession): void;
}

/**
 * Attaches custom synthesis logic to a construct; its `onSynthesize` is called when the containing stack is
 * synthesized
 * @param construct Construct to attach the custom synthesis to
 * @param synthesis Custom synthesis to run for the construct
 */
export function addCustomSynthesis(
  construct: IConstruct,
  synthesis: ICustomSynthesis,
): void {
  Object.defineProperty(construct, CUSTOM_SYNTHESIS_SYM, {
    value: synthesis,
    enumerable: false,
  });
}

/**
 * Returns the custom synthesis attached to a construct via addCustomSynthesis
 * @param construct Construct to read the custom synthesis from
 * @returns The attached custom synthesis, or undefined if none is attached
 */
function getCustomSynthesis(
  construct: IConstruct,
): ICustomSynthesis | undefined {
  return (construct as any)[CUSTOM_SYNTHESIS_SYM];
}
