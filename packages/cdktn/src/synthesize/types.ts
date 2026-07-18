// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Manifest } from "../manifest";

/**
 * Encodes information how a certain Stack should be deployed
 * inspired by AWS CDK v2 implementation (synth functionality was removed in constructs v10)
 */
export interface IStackSynthesizer {
  /**
   * Synthesize the associated stack to the session
   */
  synthesize(session: ISynthesisSession): void;
}

/**
 * Represents a single session of synthesis. Passed into `TerraformStack.onSynthesize()` methods.
 * originally from aws/constructs lib v3.3.126 (synth functionality was removed in constructs v10)
 */
export interface ISynthesisSession {
  /**
   * The output directory for this synthesis session.
   */
  readonly outdir: string;

  readonly skipValidation?: boolean;

  readonly manifest: Manifest;

  /**
   * Whether every stack that will be synthesized in this session already
   * had `prepareStack()` run against it, for ALL of those stacks, before
   * any of their synthesizers are invoked.
   *
   * `App.synth()` sets this to `true`: it calls `prepareStack()` on every
   * stack up front, so resolve-discovered provider-feature usage (see
   * `TerraformElement._registerResolveDiscoveredProviderFeatureUsage`) and
   * Terraform-function usage are visible across ALL of an App's stacks
   * before ANY of them run validations - a cross-stack reference in stack B
   * that only surfaces usage while resolving stack A must not make stack
   * A's validation miss it.
   *
   * Left unset (or `false`) by sessions built outside `App.synth()` (a
   * `StackSynthesizer` driven directly). `StackSynthesizer.synthesize()`
   * then runs `prepareStack()` itself before validating, so those entry
   * points still discover current-pass usage instead of silently skipping
   * the validations that depend on it - at the cost of only ever seeing
   * that one stack's own usage, since no sibling-stack preparation happened
   * first.
   */
  readonly stacksPrepared?: boolean;

  /**
   * Additional context passed to synthesizeNode through `sessionContext`.
   * @internal
   */
  [key: string]: any;
}
