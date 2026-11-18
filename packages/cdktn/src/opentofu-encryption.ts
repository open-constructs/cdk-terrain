// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from "constructs";
import { resolve } from "./_tokens";
import { Token, Tokenization } from "./tokens/token";
import { Annotations } from "./annotations";
import {
  duplicateOpenTofuRemoteStateSource,
  invalidOpenTofuEncryptionIdentifier,
  invalidOpenTofuRemoteStateSource,
  multipleOpenTofuEncryptions,
  openTofuEncryptionDuplicate,
} from "./errors";
import { TerraformElement } from "./terraform-element";
import { TerraformRemoteState } from "./terraform-remote-state";
import { TerraformStack } from "./terraform-stack";
import {
  checkFeatureSupportedByTargets,
  resolveTargetVersions,
} from "./validations/target-versions";

const ENCRYPTION_SYMBOL = Symbol.for("cdktf/OpenTofuEncryption");
const KEY_PROVIDER_SYMBOL = Symbol.for("cdktf/OpenTofuKeyProvider");

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// OpenTofu 1.7 supports encryption, but only 1.8+ reads the .tofu.json file it is written to
const SUPPORTED_IN = { opentofu: ">=1.8.0" };

// An attribute or key provider that needs a newer OpenTofu than encryption itself
interface Requirement {
  readonly feature: string;
  readonly opentofu: string;
}

const METADATA_ALIAS: Requirement = {
  feature: "The encrypted_metadata_alias attribute",
  opentofu: ">=1.9.0",
};

/**
 * Configuration for {@link OpenTofuKeyProvider.pbkdf2}. Set exactly one of `passphrase` and `chain`.
 */
export interface OpenTofuPbkdf2KeyProviderConfig {
  /**
   * The passphrase, at least 16 characters long. Read it from a sensitive `TerraformVariable` instead of writing it
   * into the code.
   *
   * @default - the key comes from `chain`
   */
  readonly passphrase?: string;

  /**
   * A key provider whose output is used as the passphrase. Needs OpenTofu 1.10 or later.
   *
   * @default - the key comes from `passphrase`
   */
  readonly chain?: OpenTofuKeyProvider;

  /**
   * The length of the generated key in bytes.
   *
   * @default 32
   */
  readonly keyLength?: number;

  /**
   * The number of iterations, at least 200000.
   *
   * @default 600000
   */
  readonly iterations?: number;

  /**
   * The length of the salt in bytes.
   *
   * @default 32
   */
  readonly saltLength?: number;

  /**
   * The hash function, `sha256` or `sha512`.
   *
   * @default "sha512"
   */
  readonly hashFunction?: string;

  /**
   * The key under which the key provider's metadata is stored, so that it survives renaming the key provider. Needs
   * OpenTofu 1.9 or later.
   *
   * @default - the key provider's type and name
   */
  readonly encryptedMetadataAlias?: string;
}

/**
 * Configuration for {@link OpenTofuEncryptionMethod.aesGcm}.
 */
export interface OpenTofuAesGcmMethodConfig {
  /**
   * The key provider the method encrypts with. Its key must be 16, 24 or 32 bytes long.
   */
  readonly keys: OpenTofuKeyProvider;

  /**
   * Additional authenticated data, as bytes. Decryption fails unless it matches the value used for encryption.
   *
   * @default - none
   */
  readonly aad?: number[];
}

/**
 * A key provider for {@link OpenTofuEncryption}. The key providers that the encryption's methods use are written to
 * the `encryption` block, so they don't need to be added anywhere.
 */
export class OpenTofuKeyProvider {
  /**
   * Derives a key from a passphrase.
   * @param name - a name for the key provider, unique among `pbkdf2` key providers
   * @param config - the passphrase and key derivation settings
   * @returns the key provider
   */
  public static pbkdf2(
    name: string,
    config: OpenTofuPbkdf2KeyProviderConfig,
  ): OpenTofuKeyProvider {
    const requires: Requirement[] = [];
    if (config.chain) {
      requires.push({
        feature: "The pbkdf2 key provider's chain attribute",
        opentofu: ">=1.10.0",
      });
    }
    if (config.encryptedMetadataAlias !== undefined) {
      requires.push(METADATA_ALIAS);
    }
    return new OpenTofuKeyProvider(
      "pbkdf2",
      name,
      {
        passphrase: config.passphrase,
        chain: config.chain,
        key_length: config.keyLength,
        iterations: config.iterations,
        salt_length: config.saltLength,
        hash_function: config.hashFunction,
        encrypted_metadata_alias: config.encryptedMetadataAlias,
      },
      requires,
    );
  }

  /**
   * A key provider of any type, with its attributes written as given. Nested objects are written as object
   * attributes, not blocks, and key providers as references to them.
   * @param type - the key provider type, e.g. `aws_kms`
   * @param name - a name for the key provider, unique among key providers of the same type
   * @param config - the key provider's attributes, named as in the OpenTofu documentation
   * @returns the key provider
   */
  public static custom(
    type: string,
    name: string,
    config: { [key: string]: any } = {},
  ): OpenTofuKeyProvider {
    return new OpenTofuKeyProvider(type, name, config, []);
  }

  /**
   * A key provider that is declared outside the stack, e.g. in the `TF_ENCRYPTION` environment variable, so it is
   * referenced but not written.
   * @param type - the key provider type
   * @param name - the key provider's name
   * @returns the key provider
   */
  public static fromEnvironment(
    type: string,
    name: string,
  ): OpenTofuKeyProvider {
    return new OpenTofuKeyProvider(type, name, undefined, []);
  }

  /**
   * The key provider type, e.g. `pbkdf2`.
   */
  public readonly type: string;

  /**
   * The key provider's name.
   */
  public readonly name: string;

  /**
   * The attributes, or undefined if the key provider is declared outside the stack.
   * @internal
   */
  public readonly _config?: { [key: string]: any };

  /**
   * @internal
   */
  public readonly _requires: Requirement[];

  private constructor(
    type: string,
    name: string,
    config: { [key: string]: any } | undefined,
    requires: Requirement[],
  ) {
    checkIdentifier(type);
    checkIdentifier(name);
    this.type = type;
    this.name = name;
    this._config = config;
    this._requires = requires;
    Object.defineProperty(this, KEY_PROVIDER_SYMBOL, { value: true });
  }
}

/**
 * An encryption method for {@link OpenTofuEncryption}. The methods that the encryption's targets use are written to
 * the `encryption` block, so they don't need to be added anywhere.
 */
export class OpenTofuEncryptionMethod {
  /**
   * Encrypts with AES-GCM.
   * @param name - a name for the method, unique among `aes_gcm` methods
   * @param config - the key provider
   * @returns the method
   */
  public static aesGcm(
    name: string,
    config: OpenTofuAesGcmMethodConfig,
  ): OpenTofuEncryptionMethod {
    return new OpenTofuEncryptionMethod("aes_gcm", name, {
      keys: config.keys,
      aad: config.aad,
    });
  }

  /**
   * Leaves the data unencrypted, as a `fallback` while migrating existing state, or as `method` while removing
   * encryption.
   * @param name - a name for the method, unique among `unencrypted` methods
   * @returns the method
   */
  public static unencrypted(name: string): OpenTofuEncryptionMethod {
    return new OpenTofuEncryptionMethod("unencrypted", name, {});
  }

  /**
   * A method of any type, with its attributes written as given. Nested objects are written as object attributes, not
   * blocks, and key providers as references to them.
   * @param type - the method type
   * @param name - a name for the method, unique among methods of the same type
   * @param config - the method's attributes, named as in the OpenTofu documentation, e.g. `keys`
   * @returns the method
   */
  public static custom(
    type: string,
    name: string,
    config: { [key: string]: any } = {},
  ): OpenTofuEncryptionMethod {
    return new OpenTofuEncryptionMethod(type, name, config);
  }

  /**
   * A method that is declared outside the stack, e.g. in the `TF_ENCRYPTION` environment variable, so it is
   * referenced but not written.
   * @param type - the method type
   * @param name - the method's name
   * @returns the method
   */
  public static fromEnvironment(
    type: string,
    name: string,
  ): OpenTofuEncryptionMethod {
    return new OpenTofuEncryptionMethod(type, name, undefined);
  }

  /**
   * The method type, e.g. `aes_gcm`.
   */
  public readonly type: string;

  /**
   * The method's name.
   */
  public readonly name: string;

  /**
   * The attributes, or undefined if the method is declared outside the stack.
   * @internal
   */
  public readonly _config?: { [key: string]: any };

  private constructor(
    type: string,
    name: string,
    config: { [key: string]: any } | undefined,
  ) {
    checkIdentifier(type);
    checkIdentifier(name);
    this.type = type;
    this.name = name;
    this._config = config;
  }
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

const TRAVERSAL = Symbol("traversal");

// A reference such as `method.aes_gcm.main`, which OpenTofu only accepts as a bare traversal, never as `${...}`
interface Traversal {
  readonly [TRAVERSAL]: string;
}

interface Block {
  readonly type: string;
  readonly labels: string[];
  readonly attributes: { [key: string]: any };
  readonly blocks: Block[];
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
    const method = OpenTofuEncryptionMethod.aesGcm(options.keys.name, {
      keys: options.keys,
    });
    const fallback = options.migrateFromUnencrypted
      ? OpenTofuEncryptionMethod.unencrypted("migrate")
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
    for (const keyProvider of keyProviders) {
      for (const requirement of keyProvider._requires) {
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
    for (const source of this.remoteStateSources) {
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
      ...this.remoteStateSources,
    ].filter((target) => target !== undefined);
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
    for (const source of this.remoteStateSources) {
      const dataSource = source.fromStack
        ? this.stack._incomingCrossStackDataSource(source.fromStack)
        : source.dataSource;
      if (dataSource) {
        remoteStateBlocks.push(
          targetBlock(
            "remote_state_data_source",
            [dataSource.friendlyUniqueId],
            source,
          ),
        );
      }
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

// The root and first attribute of each traversal in the `${...}` expressions of a block's attributes
const EXPRESSION_REFERENCE =
  /(?<![\w.)\]-])([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)/g;
const IGNORED_REFERENCE_ROOTS = ["path", "terraform"];

/**
 * Finds the references, such as `var.passphrase`, in the expressions of a block's attribute values.
 * @param block - the block
 * @returns the references, as root and first attribute
 */
function references(block: Block): string[] {
  const found = new Set<string>();
  const visit = (value: any): void => {
    if (typeof value === "string") {
      for (const segment of templateSegments(value)) {
        if (!segment.expression) continue;
        // quoted strings inside the expression aren't references
        const code = segment.text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
        for (const [, root, attribute] of code.matchAll(EXPRESSION_REFERENCE)) {
          if (!IGNORED_REFERENCE_ROOTS.includes(root)) {
            found.add(`${root}.${attribute}`);
          }
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (isPlainObject(value)) {
      Object.values(value).forEach(visit);
    }
  };
  visit(block.attributes);
  block.blocks.forEach((child) =>
    references(child).forEach((r) => found.add(r)),
  );
  return [...found];
}

/**
 * Splits a template string into literal text and `${...}` expressions. `$${` is an escaped literal `${`.
 * @param str - the string
 * @returns the segments, in order
 */
function templateSegments(
  str: string,
): { text: string; expression: boolean }[] {
  const segments: { text: string; expression: boolean }[] = [];
  let literal = "";
  let i = 0;
  while (i < str.length) {
    if (str.startsWith("$${", i)) {
      literal += "$${";
      i += 3;
    } else if (str.startsWith("${", i)) {
      const end = expressionEnd(str, i + 2);
      if (end === -1) {
        literal += str.slice(i);
        break;
      }
      if (literal) segments.push({ text: literal, expression: false });
      segments.push({ text: str.slice(i, end + 1), expression: true });
      literal = "";
      i = end + 1;
    } else {
      literal += str[i];
      i += 1;
    }
  }
  if (literal) segments.push({ text: literal, expression: false });
  return segments;
}

/**
 * Finds the `}` that closes an expression, skipping nested braces and quoted strings.
 * @param str - the string
 * @param start - the index after the opening `${`
 * @returns the index of the closing `}`, or -1 if it isn't closed
 */
function expressionEnd(str: string, start: number): number {
  let depth = 1;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (c === '"') {
      for (i++; i < str.length && str[i] !== '"'; i++) {
        if (str[i] === "\\") i++;
      }
    } else if (c === "{") {
      depth++;
    } else if (c === "}" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Renders a string as an HCL quoted template. Literal text is escaped; `${...}` expressions are HCL already, so
 * escaping the quotes inside them would break them.
 * @param str - the string, e.g. a resolved token such as `${file("pass.txt")}`
 * @returns the quoted template
 */
function renderHclString(str: string): string {
  const body = templateSegments(str)
    .map(({ text, expression }) =>
      expression ? text : text.replace(/[\\"\n\r\t]/g, (c) => HCL_ESCAPES[c]),
    )
    .join("");
  return `"${body}"`;
}

const HCL_ESCAPES: { [char: string]: string } = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

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
 * Checks whether the value is an {@link OpenTofuKeyProvider}.
 * @param value - any value
 * @returns true for a key provider
 */
function isKeyProvider(value: any): value is OpenTofuKeyProvider {
  return (
    typeof value === "object" && value !== null && KEY_PROVIDER_SYMBOL in value
  );
}

/**
 * Finds the key providers that a key provider's or method's attributes reference.
 * @param value - the attributes, or part of them
 * @returns the key providers
 */
function keyProvidersIn(value: any): OpenTofuKeyProvider[] {
  if (isKeyProvider(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(keyProvidersIn);
  if (isPlainObject(value)) {
    return Object.values(value).flatMap(keyProvidersIn);
  }
  return [];
}

/**
 * Builds a reference to a key provider or method.
 * @param kind - what the reference points to
 * @param ref - the key provider or method
 * @returns the reference
 */
function traversal(
  kind: "key_provider" | "method",
  ref: { readonly type: string; readonly name: string },
): Traversal {
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
 * Checks whether the value is an object other than an array, a reference, a key provider or a token.
 * @param value - any value
 * @returns true for a plain object
 */
function isPlainObject(value: any): value is { [key: string]: any } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isTraversal(value) &&
    !isKeyProvider(value) &&
    !Tokenization.isResolvable(value)
  );
}

/**
 * Resolves the tokens in a key provider's or method's attributes, and turns key providers into references.
 * @param scope - the scope to resolve tokens in
 * @param value - the attributes, or part of them
 * @returns the resolved value
 */
function resolveAttribute(scope: Construct, value: any): any {
  if (isKeyProvider(value)) return traversal("key_provider", value);
  if (Array.isArray(value)) return value.map((v) => resolveAttribute(scope, v));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, resolveAttribute(scope, v)]),
    );
  }
  return resolve(scope, value);
}

/**
 * Builds the `key_provider` or `method` block declaring a key provider or method.
 * @param scope - the scope to resolve tokens in
 * @param kind - the block type
 * @param element - the key provider or method
 * @returns the block
 */
function declarationBlock(
  scope: Construct,
  kind: "key_provider" | "method",
  element: OpenTofuKeyProvider | OpenTofuEncryptionMethod,
): Block {
  return {
    type: kind,
    labels: [element.type, element.name],
    attributes: resolveAttribute(scope, element._config),
    blocks: [],
  };
}

/**
 * Builds the block of a target, e.g. `state`.
 * @param type - the block type
 * @param labels - the block labels
 * @param target - the target
 * @returns the block
 */
function targetBlock(
  type: string,
  labels: string[],
  target: OpenTofuEncryptionTarget | OpenTofuEncryptionRemoteStateTarget,
): Block {
  const attributes: { [key: string]: any } = {
    method: traversal("method", target.method),
  };
  if ("enforced" in target && target.enforced !== undefined) {
    attributes.enforced = target.enforced;
  }
  const blocks: Block[] = target.fallback
    ? [
        {
          type: "fallback",
          labels: [],
          attributes: { method: traversal("method", target.fallback) },
          blocks: [],
        },
      ]
    : [];
  return { type, labels, attributes, blocks };
}

/**
 * Converts references to the bare strings Terraform JSON configuration expects.
 * @param value - an attribute value
 * @returns the JSON value
 */
function toJsonValue(value: any): any {
  if (isTraversal(value)) return value[TRAVERSAL];
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toJsonValue(v)]),
    );
  }
  return value;
}

/**
 * Renders a block's content as Terraform JSON configuration, nesting labelled blocks by type and labels.
 * @param block - the block
 * @returns the JSON object
 */
function blockToJson(block: Block): { [key: string]: any } {
  const json = toJsonValue(block.attributes);
  for (const child of block.blocks) {
    const path = [child.type, ...child.labels];
    let parent = json;
    for (const key of path.slice(0, -1)) {
      parent = parent[key] ??= {};
    }
    parent[path[path.length - 1]] = blockToJson(child);
  }
  return json;
}

/**
 * Renders a block as HCL.
 * @param block - the block
 * @param indent - the block's indentation
 * @returns the block's lines
 */
function blockToHcl(block: Block, indent: string): string[] {
  const header = [block.type, ...block.labels.map((l) => JSON.stringify(l))];
  const inner = `${indent}  `;
  const lines = [
    ...Object.entries(block.attributes).map(
      ([key, value]) => `${inner}${key} = ${renderHclExpression(value)}`,
    ),
    ...block.blocks.flatMap((child) => blockToHcl(child, inner)),
  ];
  if (lines.length === 0) return [`${indent}${header.join(" ")} {}`];
  return [`${indent}${header.join(" ")} {`, ...lines, `${indent}}`];
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
    const entries = Object.entries(value).map(
      ([k, v]) => `${JSON.stringify(k)} = ${renderHclExpression(v)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  if (typeof value === "string") return renderHclString(value);
  return JSON.stringify(value);
}
