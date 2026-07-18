/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { ModuleSchema } from "./module-schema";

export interface ProviderSchema {
  /*
    0.1 is e.g. returned by Terraform 0.14
    0.2 is e.g. returned by Terraform 1.0 (0.2 added support for nested_type / plugin protocol v6)
    */
  format_version?: "0.1" | "0.2";
  provider_schemas?: { [fqpn: string]: Provider };
  provider_versions?: { [fqpn: string]: string };
  /**
   * Name of the CLI (terraform/opentofu) that fetched this schema, stamped
   * by readProviderSchema. Used to reason about which newer-protocol
   * sections (functions, ephemeral resources, ...) this particular fetch
   * could possibly have emitted.
   */
  cli_name?: string;
  /**
   * Version of the CLI that fetched this schema, e.g. "1.7.5".
   */
  cli_version?: string;
}

export interface Provider {
  provider: Schema;
  resource_schemas: { [type: string]: Schema };
  data_source_schemas: { [type: string]: Schema };
  // list_resource_schemas, action_schemas and state_store_schemas are real
  // sections of `terraform providers schema -json` (Terraform-only today;
  // OpenTofu emits none). They are intentionally left untyped and
  // unconsumed: they pass through parse/sanitize/cache verbatim so cached
  // schemas stay complete, but no bindings are generated for them yet
  // (deferred - RFC-04 Phase 4; re-evaluate when opentofu/opentofu#3787
  // lands).
  ephemeral_resource_schemas?: { [type: string]: Schema };
  functions?: { [name: string]: FunctionSignature };
  resource_identity_schemas?: { [type: string]: ResourceIdentitySchema };
}

/**
 * A single parameter (or the variadic parameter) of a provider function.
 * The providers-schema JSON fields are exactly: name, description,
 * is_nullable, type. `is_nullable` derives from the plugin-protocol
 * `AllowNullValue` field and means the parameter accepts an explicit null
 * argument. Other protocol-only fields (e.g. `allow_unknown_values`) never
 * reach the providers-schema JSON.
 */
export interface FunctionParameter {
  name?: string;
  type: AttributeType;
  description?: string;
  is_nullable?: boolean;
}

export interface FunctionSignature {
  description?: string;
  summary?: string;
  // Emitted by Terraform (>=1.8) for provider-defined functions; OpenTofu
  // does not emit this field at all - a real divergence, do not "fix" by
  // expecting parity.
  deprecation_message?: string;
  return_type: AttributeType;
  parameters?: FunctionParameter[];
  variadic_parameter?: FunctionParameter;
}

export interface IdentityAttribute {
  type?: AttributeType;
  description?: string;
  required_for_import?: boolean;
  optional_for_import?: boolean;
}

export interface ResourceIdentitySchema {
  version: number;
  attributes: { [name: string]: IdentityAttribute };
}

export interface Schema {
  version: number;
  block: Block;
}

type AttributeNestedTypeNesting = "invalid" | "single" | "list" | "set" | "map";

/**
 * In tfplugin6.0.proto this as called Object to avoid
 * collisions with the native JavaScript Object we call it
 * AttributeNestedType here
 */
export interface AttributeNestedType {
  attributes: { [name: string]: Attribute } | undefined;
  nesting_mode: AttributeNestedTypeNesting;
}

export function isAttributeNestedType(
  type: AttributeType | AttributeNestedType,
): type is AttributeNestedType {
  return (
    typeof type === "object" &&
    !Array.isArray(type) &&
    typeof type.nesting_mode === "string" &&
    (typeof type.attributes === "object" ||
      typeof type.attributes === "undefined")
  );
}

interface BaseAttribute {
  type?: AttributeType;
  nested_type?: AttributeNestedType;
  description?: string;
  required?: boolean;
  optional?: boolean;
  computed?: boolean;
  sensitive?: boolean;
  write_only?: boolean;
}

interface NestedTypeAttribute extends BaseAttribute {
  type?: never;
  nested_type: AttributeNestedType;
}
interface TypedAttribute extends BaseAttribute {
  type: AttributeType;
  nested_type?: never;
}

// to support either type or nested_type being set
export type Attribute = NestedTypeAttribute | TypedAttribute;

export function isNestedTypeAttribute(
  att: Attribute,
): att is NestedTypeAttribute {
  return (
    typeof att.nested_type !== "undefined" &&
    isAttributeNestedType(att.nested_type)
  );
}

export type AttributeType =
  | "string"
  | "bool"
  | "number"
  | "dynamic"
  | ["set", AttributeType]
  | ["map", AttributeType]
  | ["list", AttributeType]
  | ["object", { [attribute: string]: AttributeType }];

export type BlockType =
  | {
      nesting_mode: "single" | "map";
      block: Block;
    }
  | {
      nesting_mode: "list" | "set";
      block: Block;
      min_items?: number;
      max_items?: number;
    };

export interface Block {
  attributes: { [name: string]: Attribute };
  block_types: { [name: string]: BlockType };
}

export interface TerraformSchema {
  providers: ProviderSchema;
  modules: ModuleSchema;
}

export interface VersionSchema {
  provider_selections: { [fqn: string]: string };
  // other properties aren't used
}

interface ModuleIndexItem {
  Key: string;
  Source: string;
  Dir: string;
  Version?: string;
}
export interface ModuleIndex {
  Modules: ModuleIndexItem[];
}
