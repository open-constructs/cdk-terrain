// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from "constructs";
import { resolve } from "./_tokens";
import { Annotations } from "./annotations";
import {
  invalidOpenTofuEncryptionIdentifier,
  multipleOpenTofuEncryptions,
  openTofuEncryptionDuplicate,
} from "./errors";
import { TerraformStack } from "./terraform-stack";
import {
  checkFeatureSupportedByTargets,
  resolveTargetVersions,
} from "./validations/target-versions";

const ENCRYPTION_SYMBOL = Symbol.for("cdktf/OpenTofuEncryption");

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// OpenTofu 1.7 supports encryption, but only 1.8+ reads the .tofu.json file it is written to
const SUPPORTED_IN = { opentofu: ">=1.8.0" };

/**
 * A key provider declared in an `encryption` block, either with {@link OpenTofuEncryption.addKeyProvider} or outside
 * the stack, e.g. in the `TF_ENCRYPTION` environment variable.
 */
export interface OpenTofuEncryptionKeyProvider {
  /**
   * The key provider type, e.g. `pbkdf2` or `aws_kms`.
   */
  readonly type: string;

  /**
   * The key provider's name.
   */
  readonly name: string;
}

/**
 * An encryption method declared in an `encryption` block, either with {@link OpenTofuEncryption.addMethod} or outside
 * the stack, e.g. in the `TF_ENCRYPTION` environment variable.
 */
export interface OpenTofuEncryptionMethod {
  /**
   * The method type, e.g. `aes_gcm` or `unencrypted`.
   */
  readonly type: string;

  /**
   * The method's name.
   */
  readonly name: string;
}

/**
 * Options for {@link OpenTofuEncryption.addMethod}.
 */
export interface OpenTofuEncryptionMethodOptions {
  /**
   * The key provider the method encrypts with.
   *
   * @default - no `keys` attribute, as for the `unencrypted` method
   */
  readonly keys?: OpenTofuEncryptionKeyProvider;

  /**
   * Further attributes of the method, e.g. `aad` for `aes_gcm`.
   *
   * @default - none
   */
  readonly config?: { [key: string]: any };
}

/**
 * How OpenTofu decrypts the state that `terraform_remote_state` data sources read.
 */
export interface OpenTofuEncryptionRemoteStateTarget {
  /**
   * The method to decrypt with.
   */
  readonly method: OpenTofuEncryptionMethod;

  /**
   * A method to try when `method` can't decrypt the data, e.g. an `unencrypted` method while migrating existing state.
   *
   * @default - no fallback
   */
  readonly fallback?: OpenTofuEncryptionMethod;
}

/**
 * How OpenTofu encrypts the stack's state or plan files.
 */
export interface OpenTofuEncryptionTarget extends OpenTofuEncryptionRemoteStateTarget {
  /**
   * Whether OpenTofu refuses to write unencrypted data, even if `method` or `fallback` is an `unencrypted` method.
   *
   * @default false
   */
  readonly enforced?: boolean;
}

const TRAVERSAL = Symbol("traversal");

// A reference such as `method.aes_gcm.main`, which OpenTofu only accepts as a bare traversal, never as `${...}`
interface Traversal {
  readonly [TRAVERSAL]: string;
}

interface Declaration {
  readonly type: string;
  readonly name: string;
  readonly config: { [key: string]: any };
  readonly keys?: Traversal;
}

/**
 * OpenTofu's state and plan encryption (`terraform { encryption { ... } }`) for the stack it is added to.
 *
 * The block is written to the stack's `settings.tofu.json` (`settings.tofu` with HCL output), which Terraform never
 * reads, and needs `targetVersions.opentofu` to be `>=1.8.0` or narrower. Losing the key loses the state. Existing
 * unencrypted state needs an `unencrypted` method as `fallback` to migrate.
 *
 * @see https://opentofu.org/docs/language/state/encryption/
 */
export class OpenTofuEncryption extends Construct {
  /**
   * Checks whether the given value is an OpenTofuEncryption.
   * @param x - any value
   * @returns true if `x` is an OpenTofuEncryption
   */
  public static isOpenTofuEncryption(x: any): x is OpenTofuEncryption {
    return x !== null && typeof x === "object" && ENCRYPTION_SYMBOL in x;
  }

  private readonly keyProviders = new Map<string, Declaration>();
  private readonly methods = new Map<string, Declaration>();
  private stateTarget?: OpenTofuEncryptionTarget;
  private planTarget?: OpenTofuEncryptionTarget;
  private remoteStateTarget?: OpenTofuEncryptionRemoteStateTarget;

  /**
   * @param scope - a stack, or a construct inside one, that doesn't have an OpenTofuEncryption yet
   * @param id - the construct id
   */
  constructor(scope: Construct, id: string) {
    super(scope, id);
    Object.defineProperty(this, ENCRYPTION_SYMBOL, { value: true });

    const stack = TerraformStack.of(this);
    if (
      stack.node
        .findAll()
        .some((c) => c !== this && OpenTofuEncryption.isOpenTofuEncryption(c))
    ) {
      throw multipleOpenTofuEncryptions(stack.node.path);
    }

    const { targets } = resolveTargetVersions(this);
    if (targets?.terraform !== undefined) {
      Annotations.of(this).addWarning(
        `The project targets terraform ${targets.terraform}, but Terraform doesn't support state encryption, so the state and plan files Terraform writes for this stack aren't encrypted. Declare targetVersions without terraform if the project only runs OpenTofu.`,
      );
    }

    this.node.addValidation({ validate: () => this.validateTargets() });
  }

  /**
   * Declares a key provider, e.g. `pbkdf2` with a `passphrase`.
   * @param type - the key provider type, e.g. `pbkdf2`, `aws_kms`, `gcp_kms` or `openbao`
   * @param name - a name for the key provider, unique among key providers of the same type
   * @param config - the key provider's attributes; read secrets from a sensitive `TerraformVariable` instead of
   * writing them into the code
   * @returns a reference to the key provider, for {@link addMethod}
   */
  public addKeyProvider(
    type: string,
    name: string,
    config: { [key: string]: any } = {},
  ): OpenTofuEncryptionKeyProvider {
    return declare(this.keyProviders, "key_provider", { type, name, config });
  }

  /**
   * Declares an encryption method, e.g. `aes_gcm` with a key provider, or `unencrypted` for migrations.
   * @param type - the method type, e.g. `aes_gcm` or `unencrypted`
   * @param name - a name for the method, unique among methods of the same type
   * @param options - the key provider and further attributes of the method
   * @returns a reference to the method, for {@link encryptState}, {@link encryptPlan} and
   * {@link encryptRemoteStateDataSources}
   */
  public addMethod(
    type: string,
    name: string,
    options: OpenTofuEncryptionMethodOptions = {},
  ): OpenTofuEncryptionMethod {
    return declare(this.methods, "method", {
      type,
      name,
      config: options.config ?? {},
      keys: options.keys && traversal("key_provider", options.keys),
    });
  }

  /**
   * Encrypts the stack's state, replacing an earlier call.
   * @param target - the method, fallback and enforcement
   */
  public encryptState(target: OpenTofuEncryptionTarget): void {
    this.stateTarget = checkedTarget(target);
  }

  /**
   * Encrypts the stack's plan files, replacing an earlier call.
   * @param target - the method, fallback and enforcement
   */
  public encryptPlan(target: OpenTofuEncryptionTarget): void {
    this.planTarget = checkedTarget(target);
  }

  /**
   * Decrypts the state that the stack's `terraform_remote_state` data sources read, including the ones cdktn adds
   * for cross-stack references, replacing an earlier call.
   * @param target - the method and fallback
   */
  public encryptRemoteStateDataSources(
    target: OpenTofuEncryptionRemoteStateTarget,
  ): void {
    this.remoteStateTarget = checkedTarget(target);
  }

  /**
   * Renders the `encryption` block as Terraform JSON configuration.
   * @returns the block's content
   * @internal
   */
  public _toJson(): { [key: string]: any } {
    return toJsonValue(this.block());
  }

  /**
   * Renders the `encryption` block as HCL, indented to sit inside a `terraform` block.
   * @returns the block, without a trailing newline
   * @internal
   */
  public _toHcl(): string {
    return renderHclBlock("encryption", this.block(), "  ").join("\n");
  }

  private validateTargets(): string[] {
    const { targets, errors } = resolveTargetVersions(this);
    if (!targets) {
      return errors;
    }
    if (targets.opentofu === undefined) {
      return [
        `OpenTofu encryption is only supported by OpenTofu, but the project doesn't target it. Set targetVersions.opentofu to "${SUPPORTED_IN.opentofu}" or narrower.`,
      ];
    }
    return checkFeatureSupportedByTargets(
      "OpenTofu encryption",
      SUPPORTED_IN,
      { opentofu: targets.opentofu },
      `OpenTofu 1.7 doesn't read settings.tofu.json, where cdktn writes the encryption block. Set targetVersions.opentofu to "${SUPPORTED_IN.opentofu}" or narrower.`,
    );
  }

  private block(): { [key: string]: any } {
    const block: { [key: string]: any } = {};
    const keyProviders = this.grouped(this.keyProviders);
    const methods = this.grouped(this.methods);
    if (keyProviders) block.key_provider = keyProviders;
    if (methods) block.method = methods;
    if (this.stateTarget) block.state = targetBlock(this.stateTarget);
    if (this.planTarget) block.plan = targetBlock(this.planTarget);
    if (this.remoteStateTarget) {
      block.remote_state_data_sources = {
        default: targetBlock(this.remoteStateTarget),
      };
    }
    return block;
  }

  // keys is added after resolving, since resolving would drop a Traversal's symbol key
  private grouped(
    declarations: Map<string, Declaration>,
  ): { [type: string]: { [name: string]: any } } | undefined {
    if (declarations.size === 0) return undefined;
    const groups: { [type: string]: { [name: string]: any } } = {};
    for (const { type, name, config, keys } of declarations.values()) {
      const body = resolve(this, config);
      groups[type] = {
        ...groups[type],
        [name]: keys ? { ...body, keys } : body,
      };
    }
    return groups;
  }
}

/**
 * Throws unless the value can be written unquoted in a reference.
 * @param value - a key provider or method type or name
 */
function checkIdentifier(value: string): void {
  if (!IDENTIFIER.test(value)) {
    throw invalidOpenTofuEncryptionIdentifier(value);
  }
}

/**
 * Builds a reference to a key provider or method.
 * @param kind - what the reference points to
 * @param ref - the key provider's or method's type and name
 * @returns the reference
 */
function traversal(
  kind: "key_provider" | "method",
  ref: { readonly type: string; readonly name: string },
): Traversal {
  checkIdentifier(ref.type);
  checkIdentifier(ref.name);
  return { [TRAVERSAL]: `${kind}.${ref.type}.${ref.name}` };
}

/**
 * Checks whether the value is a reference built by {@link traversal}.
 * @param value - any value
 * @returns true for a reference
 */
function isTraversal(value: any): value is Traversal {
  return typeof value === "object" && value !== null && TRAVERSAL in value;
}

/**
 * Adds a key provider or method, rejecting a second one with the same type and name.
 * @param declarations - the key providers or methods declared so far
 * @param kind - which of the two `declarations` holds, for the error message
 * @param declaration - the key provider or method to add
 * @returns the reference users pass on
 */
function declare(
  declarations: Map<string, Declaration>,
  kind: "key_provider" | "method",
  declaration: Declaration,
): { type: string; name: string } {
  const { type, name } = declaration;
  checkIdentifier(type);
  checkIdentifier(name);
  const key = `${type}.${name}`;
  if (declarations.has(key)) {
    throw openTofuEncryptionDuplicate(`${kind}.${key}`);
  }
  declarations.set(key, declaration);
  return { type, name };
}

/**
 * Checks a target's method references when it is set, so that a bad one fails where it is passed.
 * @param target - the target to check
 * @returns the target
 */
function checkedTarget<T extends OpenTofuEncryptionRemoteStateTarget>(
  target: T,
): T {
  targetBlock(target);
  return target;
}

/**
 * Builds the `state`, `plan` or `remote_state_data_sources.default` block of a target.
 * @param target - the target
 * @returns the block's content
 */
function targetBlock(
  target: OpenTofuEncryptionTarget | OpenTofuEncryptionRemoteStateTarget,
): { [key: string]: any } {
  const block: { [key: string]: any } = {
    method: traversal("method", target.method),
  };
  if (target.fallback) {
    block.fallback = { method: traversal("method", target.fallback) };
  }
  if ("enforced" in target && target.enforced !== undefined) {
    block.enforced = target.enforced;
  }
  return block;
}

/**
 * Checks whether the value is an object other than an array or a reference.
 * @param value - any value
 * @returns true for a plain object
 */
function isPlainObject(value: any): value is { [key: string]: any } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isTraversal(value)
  );
}

/**
 * Converts references to the bare strings Terraform JSON configuration expects.
 * @param value - part of the encryption block
 * @returns the JSON value
 */
function toJsonValue(value: any): any {
  if (isTraversal(value)) return value[TRAVERSAL];
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, toJsonValue(v)]),
    );
  }
  return value;
}

/**
 * Renders an HCL block. The structure cdktn builds (`state`, `fallback`, ...) is made of blocks, while a key
 * provider's or method's config is made of attributes, including objects such as `assume_role` for `aws_kms`.
 * @param header - the block type and labels
 * @param body - the block's content
 * @param indent - the block's indentation
 * @param attributesOnly - whether to render nested objects as attributes instead of blocks
 * @returns the block's lines
 */
function renderHclBlock(
  header: string,
  body: { [key: string]: any },
  indent: string,
  attributesOnly = false,
): string[] {
  const inner = `${indent}  `;
  const lines = [`${indent}${header} {`];
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (
      header === "encryption" &&
      (key === "key_provider" || key === "method")
    ) {
      for (const [type, byName] of Object.entries(value)) {
        for (const [name, config] of Object.entries(byName as object)) {
          lines.push(
            ...renderHclBlock(
              `${key} "${type}" "${name}"`,
              config,
              inner,
              true,
            ),
          );
        }
      }
    } else if (!attributesOnly && isPlainObject(value)) {
      lines.push(...renderHclBlock(key, value, inner));
    } else {
      lines.push(`${inner}${key} = ${renderHclExpression(value)}`);
    }
  }
  if (lines.length === 1) return [`${indent}${header} {}`];
  lines.push(`${indent}}`);
  return lines;
}

/**
 * Renders an attribute value as an HCL expression.
 * @param value - the value
 * @returns the expression
 */
function renderHclExpression(value: any): string {
  if (isTraversal(value)) return value[TRAVERSAL];
  if (Array.isArray(value)) {
    return `[${value.map(renderHclExpression).join(", ")}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)} = ${renderHclExpression(v)}`);
    return `{ ${entries.join(", ")} }`;
  }
  // a JSON string literal is a valid HCL quoted template, so `${var.x}` keeps its meaning
  return JSON.stringify(value);
}
