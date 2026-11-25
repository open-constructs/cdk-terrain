// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from "constructs";
import { Token } from "../tokens/token";
import { Annotations } from "../annotations";
import {
  duplicateOpenTofuRemoteStateSource,
  foreignOpenTofuRemoteStateSource,
  invalidOpenTofuRemoteStateSource,
  multipleOpenTofuEncryptions,
  openTofuEncryptionDuplicate,
} from "../errors";
import { TerraformElement } from "../terraform-element";
import { TerraformRemoteState } from "../terraform-remote-state";
import { TerraformStack } from "../terraform-stack";
import {
  checkFeatureSupportedByTargets,
  resolveTargetVersions,
} from "../validations/target-versions";
import { OpenTofuKeyProvider, Requirement } from "./key-provider";
import { OpenTofuEncryptionMethod } from "./method";
import { OpenTofuAesGcmMethod } from "./methods/aes-gcm";
import { OpenTofuUnencryptedMethod } from "./methods/unencrypted";
import {
  Block,
  blockToHcl,
  blockToJson,
  declarationBlock,
  keyProvidersIn,
  references,
  targetBlock,
} from "./render";

const ENCRYPTION_SYMBOL = Symbol.for("cdktf/OpenTofuEncryption");

// OpenTofu 1.7 supports encryption, but only 1.8+ reads the .tofu.json file it is written to
const SUPPORTED_IN = { opentofu: ">=1.8.0" };

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
   * Whether OpenTofu refuses to write unencrypted data. OpenTofu rejects an `unencrypted` method in an enforced
   * target, so leave this off while migrating.
   *
   * @default false
   */
  readonly enforced?: boolean;
}

/**
 * How OpenTofu decrypts the state of one remote state data source. Set exactly one of `fromStack` and `dataSource`.
 */
export interface OpenTofuEncryptionRemoteStateSource extends OpenTofuEncryptionRemoteStateTarget {
  /**
   * The stack whose outputs this stack references, for the data source cdktn adds for those references. Nothing is
   * written if the stack doesn't reference it.
   *
   * @default - the source is `dataSource`
   */
  readonly fromStack?: TerraformStack;

  /**
   * A remote state data source in this stack.
   *
   * @default - the source is `fromStack`
   */
  readonly dataSource?: TerraformRemoteState;
}

/**
 * Configuration for {@link OpenTofuEncryption}.
 */
export interface OpenTofuEncryptionConfig {
  /**
   * How the stack's state is encrypted.
   *
   * @default - the state isn't encrypted
   */
  readonly state?: OpenTofuEncryptionTarget;

  /**
   * How the stack's plan files are encrypted.
   *
   * @default - plan files aren't encrypted
   */
  readonly plan?: OpenTofuEncryptionTarget;

  /**
   * How the state that the stack's remote state data sources read is decrypted, including the ones cdktn adds for
   * cross-stack references, unless `remoteStateSources` covers them.
   *
   * @default - remote state is read unencrypted
   */
  readonly remoteState?: OpenTofuEncryptionRemoteStateTarget;

  /**
   * How the state of particular remote state data sources is decrypted, e.g. stacks with their own keys.
   *
   * @default - all remote state is decrypted as `remoteState` says
   */
  readonly remoteStateSources?: OpenTofuEncryptionRemoteStateSource[];
}

/**
 * Options for {@link OpenTofuEncryption.withKeys}.
 */
export interface OpenTofuEncryptionWithKeysOptions {
  /**
   * The key provider to encrypt with.
   */
  readonly keys: OpenTofuKeyProvider;

  /**
   * Whether the stack has existing unencrypted state. If so, unencrypted state and remote state are still read, and
   * the state isn't enforced. Remove this once the state has been applied encrypted.
   *
   * @default false
   */
  readonly migrateFromUnencrypted?: boolean;
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

  /**
   * Encrypts the stack's state and plan files with AES-GCM, and decrypts remote state the same way, e.g. for stacks
   * that share a passphrase.
   * @param scope - a stack, or a construct inside one, that doesn't have an OpenTofuEncryption yet
   * @param id - the construct id
   * @param options - the key provider, and whether existing unencrypted state is migrated
   * @returns the encryption
   */
  public static withKeys(
    scope: Construct,
    id: string,
    options: OpenTofuEncryptionWithKeysOptions,
  ): OpenTofuEncryption {
    const method = new OpenTofuAesGcmMethod(options.keys.name, {
      keys: options.keys,
    });
    const fallback = options.migrateFromUnencrypted
      ? new OpenTofuUnencryptedMethod("migrate")
      : undefined;
    return new OpenTofuEncryption(scope, id, {
      state: fallback ? { method, fallback } : { method, enforced: true },
      plan: { method, enforced: true },
      remoteState: { method, fallback },
    });
  }

  /**
   * How the stack's state is encrypted.
   */
  public state?: OpenTofuEncryptionTarget;

  /**
   * How the stack's plan files are encrypted.
   */
  public plan?: OpenTofuEncryptionTarget;

  /**
   * How the state that the stack's remote state data sources read is decrypted, unless a remote state source covers
   * them.
   */
  public remoteState?: OpenTofuEncryptionRemoteStateTarget;

  private readonly remoteStateSources: OpenTofuEncryptionRemoteStateSource[] =
    [];

  private readonly stack: TerraformStack;

  /**
   * @param scope - a stack, or a construct inside one, that doesn't have an OpenTofuEncryption yet
   * @param id - the construct id
   * @param config - the state, plan and remote state targets
   */
  constructor(
    scope: Construct,
    id: string,
    config: OpenTofuEncryptionConfig = {},
  ) {
    super(scope, id);
    Object.defineProperty(this, ENCRYPTION_SYMBOL, { value: true });

    this.stack = TerraformStack.of(this);
    if (
      this.stack.node
        .findAll()
        .some((c) => c !== this && OpenTofuEncryption.isOpenTofuEncryption(c))
    ) {
      throw multipleOpenTofuEncryptions(this.stack.node.path);
    }

    this.state = config.state;
    this.plan = config.plan;
    this.remoteState = config.remoteState;
    config.remoteStateSources?.forEach((source) =>
      this.addRemoteStateSource(source),
    );

    const { targets } = resolveTargetVersions(this);
    if (targets?.terraform !== undefined) {
      Annotations.of(this).addWarning(
        `The project targets terraform ${targets.terraform}, but Terraform doesn't support state encryption, so the state and plan files Terraform writes for this stack aren't encrypted. Declare targetVersions without terraform if the project only runs OpenTofu.`,
      );
    }

    this.node.addValidation({ validate: () => this.validateEncryption() });
  }

  /**
   * Decrypts the state of one remote state data source differently from `remoteState`.
   * @param source - the data source, or the stack whose outputs this stack references, and how to decrypt it
   */
  public addRemoteStateSource(source: OpenTofuEncryptionRemoteStateSource) {
    if (
      (source.fromStack === undefined) ===
      (source.dataSource === undefined)
    ) {
      throw invalidOpenTofuRemoteStateSource();
    }
    if (
      source.dataSource &&
      TerraformStack.of(source.dataSource) !== this.stack
    ) {
      throw foreignOpenTofuRemoteStateSource(
        source.dataSource.node.path,
        this.stack.node.path,
      );
    }
    if (
      this.remoteStateSources.some(
        (existing) =>
          (source.fromStack && existing.fromStack === source.fromStack) ||
          (source.dataSource && existing.dataSource === source.dataSource),
      )
    ) {
      throw duplicateOpenTofuRemoteStateSource(
        (source.fromStack ?? source.dataSource)!.node.path,
      );
    }
    this.remoteStateSources.push(source);
  }

  /**
   * Renders the `encryption` block as Terraform JSON configuration.
   * @returns the block's content
   * @internal
   */
  public _toJson(): { [key: string]: any } {
    return blockToJson(this.block());
  }

  /**
   * Renders the `encryption` block as HCL, indented to sit inside a `terraform` block.
   * @returns the block, without a trailing newline
   * @internal
   */
  public _toHcl(): string {
    return blockToHcl(this.block(), "  ").join("\n");
  }

  private validateEncryption(): string[] {
    const { targets, errors } = resolveTargetVersions(this);
    if (!targets) {
      return errors;
    }
    if (targets.opentofu === undefined) {
      return [
        `OpenTofu encryption is only supported by OpenTofu, but the project doesn't target it. Set targetVersions.opentofu to "${SUPPORTED_IN.opentofu}" or narrower.`,
      ];
    }
    const opentofu = { opentofu: targets.opentofu };
    const result = checkFeatureSupportedByTargets(
      "OpenTofu encryption",
      SUPPORTED_IN,
      opentofu,
      `OpenTofu 1.7 doesn't read settings.tofu.json, where cdktn writes the encryption block. Set targetVersions.opentofu to "${SUPPORTED_IN.opentofu}" or narrower.`,
    );

    const requirements = new Map<string, Requirement>();
    const { keyProviders, methods } = this.used();
    for (const element of [...keyProviders, ...methods]) {
      for (const requirement of element._requires) {
        requirements.set(requirement.feature, requirement);
      }
    }
    for (const { feature, opentofu: range } of requirements.values()) {
      result.push(
        ...checkFeatureSupportedByTargets(
          feature,
          { opentofu: range },
          opentofu,
        ),
      );
    }

    for (const [kind, target] of [
      ["state", this.state],
      ["plan", this.plan],
    ] as const) {
      const unencrypted = [target?.method, target?.fallback].find(
        (method) => method?.type === "unencrypted",
      );
      if (target?.enforced && unencrypted) {
        result.push(
          `The ${kind} encryption is enforced, but uses method.unencrypted.${unencrypted.name}, which OpenTofu rejects when enforced. Remove the unencrypted method, or leave enforced off until the existing state is migrated.`,
        );
      }
    }
    return [
      ...result,
      ...this.validateReferences(keyProviders, methods),
      ...this.validateRemoteStateKeys(),
    ];
  }

  // OpenTofu evaluates the encryption block before planning, so it only sees the stack's own variables and locals
  private validateReferences(
    keyProviders: OpenTofuKeyProvider[],
    methods: OpenTofuEncryptionMethod[],
  ): string[] {
    const declared = new Set(
      this.stack.node
        .findAll()
        .filter(TerraformElement.isTerraformElement)
        .map(
          (element) => `${element["_elementType"]}.${element.friendlyUniqueId}`,
        ),
    );
    const errors: string[] = [];
    const check = (
      kind: "key_provider" | "method",
      element: OpenTofuKeyProvider | OpenTofuEncryptionMethod,
    ) => {
      const address = `${kind}.${element.type}.${element.name}`;
      for (const reference of references(
        declarationBlock(this, kind, element),
      )) {
        if (!reference.startsWith("var.") && !reference.startsWith("local.")) {
          errors.push(
            `${address} uses ${reference}, but OpenTofu evaluates the encryption block before planning, so it can only use variables, locals and functions.`,
          );
        } else if (!declared.has(reference)) {
          errors.push(
            `${address} uses ${reference}, which the stack at '${this.stack.node.path}' doesn't declare. The encryption block can only use the stack's own variables and locals, so declare one in this stack, e.g. with the same name, so that one TF_VAR_ environment variable sets both.`,
          );
        }
      }
    };
    keyProviders.forEach((keyProvider) => check("key_provider", keyProvider));
    methods.forEach((method) => check("method", method));
    return errors;
  }

  // OpenTofu finds a key by the metadata key its state was written with, so the reader's key providers must match
  private validateRemoteStateKeys(): string[] {
    const errors: string[] = [];
    const check = (
      producer: TerraformStack,
      target: OpenTofuEncryptionRemoteStateTarget,
    ) => {
      const written = metadataKeys(
        producer.node.findAll().find(OpenTofuEncryption.isOpenTofuEncryption)
          ?.state?.method,
      );
      if (!written?.length) return;
      const readers = [target.method, target.fallback]
        .filter((method) => method !== undefined)
        .map(metadataKeys);
      if (readers.some((keys) => keys === undefined)) return;
      const read = readers.filter((keys) => keys!.length > 0) as string[][];
      if (read.some((keys) => keys.every((key) => written.includes(key)))) {
        return;
      }
      errors.push(
        `The stack at '${this.stack.node.path}' decrypts the state of the stack at '${producer.node.path}' with ${read.flat().join(", ") || "no key provider"}, but that stack encrypts its state with ${written.join(", ")}. OpenTofu finds the key by the key provider's type and name, so use a key provider with the same type and name, or the same encryptedMetadataAlias, in both stacks.`,
      );
    };

    const covered = new Set<TerraformStack>();
    for (const { source } of this.usedRemoteStateSources()) {
      if (source.fromStack) {
        covered.add(source.fromStack);
        check(source.fromStack, source);
      }
    }
    const remoteState = this.remoteState;
    if (remoteState) {
      this.node.root.node
        .findAll()
        .filter(TerraformStack.isStack)
        .filter(
          (producer) =>
            !covered.has(producer) &&
            this.stack._incomingCrossStackDataSource(producer),
        )
        .forEach((producer) => check(producer, remoteState));
    }
    return errors;
  }

  private targets(): OpenTofuEncryptionRemoteStateTarget[] {
    return [
      this.state,
      this.plan,
      this.remoteState,
      ...this.usedRemoteStateSources().map(({ source }) => source),
    ].filter((target) => target !== undefined);
  }

  // A fromStack source has no data source until this stack references that stack
  private usedRemoteStateSources(): {
    source: OpenTofuEncryptionRemoteStateSource;
    dataSource: TerraformRemoteState;
  }[] {
    return this.remoteStateSources.flatMap((source) => {
      const dataSource = source.fromStack
        ? this.stack._incomingCrossStackDataSource(source.fromStack)
        : source.dataSource;
      return dataSource ? [{ source, dataSource }] : [];
    });
  }

  // The key providers and methods the targets use, rejecting different objects with the same address
  private used(): {
    keyProviders: OpenTofuKeyProvider[];
    methods: OpenTofuEncryptionMethod[];
  } {
    const seen = new Map<string, { _config?: object }>();
    const keyProviders: OpenTofuKeyProvider[] = [];
    const methods: OpenTofuEncryptionMethod[] = [];

    const isNew = (
      kind: "key_provider" | "method",
      element: OpenTofuKeyProvider | OpenTofuEncryptionMethod,
    ) => {
      const address = `${kind}.${element.type}.${element.name}`;
      const existing = seen.get(address);
      if (existing === element) return false;
      if (existing) {
        // declarations from TF_ENCRYPTION aren't written, so equal ones can't conflict
        if (existing._config || element._config) {
          throw openTofuEncryptionDuplicate(address);
        }
        return false;
      }
      seen.set(address, element);
      return true;
    };
    const addKeyProvider = (keyProvider: OpenTofuKeyProvider) => {
      if (!isNew("key_provider", keyProvider)) return;
      if (keyProvider._config) keyProviders.push(keyProvider);
      keyProvidersIn(keyProvider._config).forEach(addKeyProvider);
    };

    for (const target of this.targets()) {
      for (const method of [target.method, target.fallback]) {
        if (!method || !isNew("method", method)) continue;
        if (method._config) methods.push(method);
        keyProvidersIn(method._config).forEach(addKeyProvider);
      }
    }
    return { keyProviders, methods };
  }

  private block(): Block {
    const { keyProviders, methods } = this.used();
    const declarations = [
      ...keyProviders.map((keyProvider) =>
        declarationBlock(this, "key_provider", keyProvider),
      ),
      ...methods.map((method) => declarationBlock(this, "method", method)),
    ];
    const targets: Block[] = [];
    if (this.state) targets.push(targetBlock("state", [], this.state));
    if (this.plan) targets.push(targetBlock("plan", [], this.plan));

    const remoteStateBlocks: Block[] = [];
    if (this.remoteState) {
      remoteStateBlocks.push(targetBlock("default", [], this.remoteState));
    }
    for (const { source, dataSource } of this.usedRemoteStateSources()) {
      remoteStateBlocks.push(
        targetBlock(
          "remote_state_data_source",
          [dataSource.friendlyUniqueId],
          source,
        ),
      );
    }
    if (remoteStateBlocks.length > 0) {
      targets.push({
        type: "remote_state_data_sources",
        labels: [],
        attributes: {},
        blocks: remoteStateBlocks,
      });
    }

    return {
      type: "encryption",
      labels: [],
      attributes: {},
      blocks: [...declarations, ...targets],
    };
  }
}

/**
 * The keys under which a method's key providers store their metadata in the state.
 * @param method - the method
 * @returns the keys, or undefined if they can't be known, e.g. for something declared in `TF_ENCRYPTION`
 */
function metadataKeys(method?: OpenTofuEncryptionMethod): string[] | undefined {
  if (!method?._config) return undefined;
  const keys: string[] = [];
  const pending = keyProvidersIn(method._config);
  while (pending.length > 0) {
    const keyProvider = pending.pop()!;
    const alias = keyProvider._config?.encrypted_metadata_alias;
    if (!keyProvider._config || Token.isUnresolved(alias)) return undefined;
    const key = alias ?? `key_provider.${keyProvider.type}.${keyProvider.name}`;
    if (keys.includes(key)) continue;
    keys.push(key);
    pending.push(...keyProvidersIn(keyProvider._config));
  }
  return keys;
}
