// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { CodeMaker } from "codemaker";
import { ResourceModel } from "../models";
import { AttributesEmitter } from "./attributes-emitter";
import { sanitizedComment } from "../sanitized-comments";

export class ResourceEmitter {
  attributesEmitter: AttributesEmitter;

  constructor(
    private readonly code: CodeMaker,
    private readonly importExtension: string,
  ) {
    this.attributesEmitter = new AttributesEmitter(this.code);
  }

  public emit(resource: ResourceModel) {
    this.code.line();

    if (resource.isProvider && resource.providerFunctionsModel) {
      // Sibling-directory import: providers/<provider>/provider/index.ts
      // (the emitted file) and providers/<provider>/provider-functions/
      // index.ts are siblings under providers/<provider>/, so unlike the
      // child-folder struct imports this one has to step up a level.
      this.code.line(
        `import { ${resource.providerFunctionsModel.className} } from '../provider-functions/index${this.importExtension}';`,
      );
    }

    const comment = sanitizedComment(this.code);
    comment.line(
      `Represents a {@link ${resource.linkToDocs} ${resource.terraformResourceType}}`,
    );
    comment.end();
    this.code.openBlock(
      `export class ${resource.className} extends cdktn.${resource.parentClassName}`,
    );

    this.emitHeader("STATIC PROPERTIES");
    this.emitStaticProperties(resource);

    if (!resource.isEphemeralResource) {
      this.emitHeader("STATIC Methods");
      this.emitStaticMethods(resource);
    }

    this.emitHeader("INITIALIZER");
    this.emitInitializer(resource);

    this.emitHeader("ATTRIBUTES");
    this.emitResourceAttributes(resource);

    if (resource.isProvider && resource.providerFunctionsModel) {
      this.emitHeader("PROVIDER-DEFINED FUNCTIONS");
      this.emitFunctionsGetter(resource.providerFunctionsModel);
    }

    // synthesis
    this.emitHeader("SYNTHESIS");
    this.emitResourceSynthesis(resource);
    this.emitHclResourceSynthesis(resource);

    this.code.closeBlock(); // construct
  }

  // Emits a memoized `functions` getter on a provider class that declares
  // provider-defined functions. The local name to invoke functions under is
  // derived from `this.terraformResourceType`, not baked in as the schema
  // name constant: terraform-provider.ts keys both `required_providers` and
  // the `provider` block directly off `terraformResourceType`, so whatever
  // this instance's `terraformResourceType` is IS its correct
  // required_providers local name (it already accounts for a `name`
  // override in the cdktf.json provider constraint, see
  // ConstructsMakerProviderTarget/TerraformProviderConstraint) - the
  // instance always knows its own correct local name, so there is no need
  // for a providerLocalName override parameter here.
  private emitFunctionsGetter(
    model: NonNullable<ResourceModel["providerFunctionsModel"]>,
  ) {
    this.code.line(`private _functions?: ${model.className};`);
    this.code.line();

    const comment = sanitizedComment(this.code);
    comment.line(
      `Provider-defined functions of the ${model.providerName} provider.`,
    );
    comment.end();
    this.code.openBlock(`public get functions(): ${model.className}`);
    this.code.openBlock(`if (!this._functions)`);
    this.code.line(
      `this._functions = new ${model.className}(this.terraformResourceType);`,
    );
    this.code.closeBlock();
    this.code.line(`return this._functions;`);
    this.code.closeBlock();
  }

  private emitHeader(title: string) {
    this.code.line();
    this.code.line("// " + "=".repeat(title.length));
    this.code.line(`// ${title}`);
    this.code.line("// " + "=".repeat(title.length));
  }

  private emitStaticProperties(resource: ResourceModel) {
    this.code.line(
      `public static readonly tfResourceType = "${resource.terraformResourceType}";`,
    );
  }

  private emitStaticMethods(resource: ResourceModel) {
    const comment = sanitizedComment(this.code);
    comment.line(
      `Generates CDKTN code for importing a ${resource.className} resource upon running "cdktn plan <stack-name>"`,
    );
    comment.line(`@param scope The scope in which to define this construct`);
    comment.line(
      `@param importToId The construct id used in the generated config for the ${resource.className} to import`,
    );
    comment.line(
      `@param importFromId The id of the existing ${resource.className} that should be imported. Refer to the {@link ${resource.linkToDocs}#import import section} in the documentation of this resource for the id to use`,
    );
    comment.line(
      `@param provider? Optional instance of the provider where the ${resource.className} to import is found`,
    );
    comment.end();
    this.code.line(
      `public static generateConfigForImport(scope: Construct, importToId: string, importFromId: string, provider?: cdktn.TerraformProvider) {
        return new cdktn.ImportableResource(scope, importToId, { terraformResourceType: "${resource.terraformResourceType}", importId: importFromId, provider });
      }`,
    );
  }

  private emitHclResourceSynthesis(resource: ResourceModel) {
    this.code.line();
    this.code.openBlock(
      `protected synthesizeHclAttributes(): { [name: string]: any }`,
    );
    this.code.open(`const attrs = {`);

    const registerWriteOnlyUsage = this.supportsWriteOnlyRegistration(resource);
    for (const att of resource.synthesizableAttributes) {
      this.attributesEmitter.emitToHclTerraform(
        att,
        false,
        registerWriteOnlyUsage,
      );
    }

    this.code.close(`};`);

    if (resource.synthesizableAttributes.length > 0) {
      this.code.line();
      this.code.line(`// remove undefined attributes`);
      this.code.line(
        `return Object.fromEntries(Object.entries(attrs).filter(([_, value]) => value !== undefined && value.value !== undefined ))`,
      );
    } else {
      this.code.line(`return attrs;`);
    }

    this.code.closeBlock();
  }

  private emitResourceSynthesis(resource: ResourceModel) {
    this.code.line();
    this.code.openBlock(
      `protected synthesizeAttributes(): { [name: string]: any }`,
    );
    this.code.open(`return {`);

    const registerWriteOnlyUsage = this.supportsWriteOnlyRegistration(resource);
    for (const att of resource.synthesizableAttributes) {
      this.attributesEmitter.emitToTerraform(
        att,
        false,
        registerWriteOnlyUsage,
      );
    }

    this.code.close(`};`);
    this.code.closeBlock();
  }

  // `markWriteOnlyAttribute` (called from generated `synthesizeAttributes()`/
  // `synthesizeHclAttributes()` for write-only attributes, see
  // AttributesEmitter#emitToTerraform/#emitToHclTerraform) lives on
  // TerraformResource - so only managed resources can register write-only
  // usage; data sources, providers, and ephemeral resources only get the
  // deprecated getter.
  //
  // write-only is fundamentally a state concept - the value is passed to
  // the provider but never persisted to state - so gating this on
  // TerraformResource is a semantic choice, not a capability one: ephemeral
  // resources have no state at all, and, consistent with that, no provider
  // schema in the RFC-04 sweep (including vault's 16 ephemeral resources)
  // marks an ephemeral attribute write_only. So ephemeral classes
  // deliberately land in the same "getter only" bucket as data sources and
  // providers.
  private supportsWriteOnlyRegistration(resource: ResourceModel): boolean {
    return resource.parentClassName === "TerraformResource";
  }

  private emitResourceAttributes(resource: ResourceModel) {
    for (const att of resource.attributes) {
      this.attributesEmitter.emit(
        att,
        this.attributesEmitter.needsResetEscape(att, resource.attributes),
        this.attributesEmitter.needsInputEscape(att, resource.attributes),
      );
    }
  }

  private emitInitializer(resource: ResourceModel) {
    this.code.line();
    const comment = sanitizedComment(this.code);
    comment.line(
      `Create a new {@link ${resource.linkToDocs} ${
        resource.terraformResourceType
      }} ${
        resource.isDataSource
          ? "Data Source"
          : resource.isEphemeralResource
            ? "Ephemeral Resource"
            : "Resource"
      }`,
    );
    comment.line(``);
    comment.line(`@param scope The scope in which to define this construct`);
    comment.line(
      `@param id The scoped construct ID. Must be unique amongst siblings in the same scope`,
    );
    comment.line(`@param options ${resource.configStruct.attributeType}`);
    comment.end();
    this.code.openBlock(
      `public constructor(scope: Construct, id: string, config: ${resource.configStruct.attributeType})`,
    );

    if (resource.isProvider) {
      this.emitProviderSuper(resource);
    } else if (resource.isEphemeralResource) {
      this.emitEphemeralResourceSuper(resource);
    } else {
      this.emitResourceSuper(resource);
    }

    // initialize config properties
    for (const att of resource.configStruct.assignableAttributes) {
      if (att.setterType._type === "stored_class") {
        this.code.line(
          `this.${att.storageName}.internalValue = config.${att.name};`,
        );
      } else {
        this.code.line(`this.${att.storageName} = config.${att.name};`);
      }
    }

    this.code.closeBlock();
  }

  private emitResourceSuper(resource: ResourceModel) {
    this.code.open(`super(scope, id, {`);
    this.code.line(
      `terraformResourceType: '${resource.terraformResourceType}',`,
    );
    this.emitTerraformGeneratorMetadata(resource);
    this.code.line(`provider: config.provider,`);
    this.code.line(`dependsOn: config.dependsOn,`);
    this.code.line(`count: config.count,`);
    this.code.line(`lifecycle: config.lifecycle,`);
    this.code.line(`provisioners: config.provisioners,`);
    this.code.line(`connection: config.connection,`);
    this.code.line(`forEach: config.forEach`);
    this.code.close(`});`);
  }

  private emitEphemeralResourceSuper(resource: ResourceModel) {
    this.code.open(`super(scope, id, {`);
    this.code.line(
      `terraformResourceType: '${resource.terraformResourceType}',`,
    );
    this.emitTerraformGeneratorMetadata(resource);
    this.code.line(`provider: config.provider,`);
    this.code.line(`dependsOn: config.dependsOn,`);
    this.code.line(`count: config.count,`);
    this.code.line(`lifecycle: config.lifecycle,`);
    this.code.line(`forEach: config.forEach`);
    this.code.close(`});`);
  }

  private emitProviderSuper(resource: ResourceModel) {
    this.code.open(`super(scope, id, {`);
    this.code.line(
      `terraformResourceType: '${resource.terraformResourceType}',`,
    );
    this.emitTerraformGeneratorMetadata(resource);
    this.code.line(
      `terraformProviderSource: '${resource.terraformProviderSource}'`,
    );
    this.code.close(`});`);
  }

  private emitTerraformGeneratorMetadata(resource: ResourceModel) {
    this.code.open(`terraformGeneratorMetadata: {`);
    this.code.line(
      `providerName: '${resource.provider}'${
        resource.providerVersion || resource.providerVersionConstraint
          ? ","
          : ""
      }`,
    );

    if (resource.providerVersion) {
      this.code.line(
        `providerVersion: '${resource.providerVersion}'${
          resource.providerVersionConstraint ? "," : ""
        }`,
      );
    }

    if (resource.providerVersionConstraint) {
      this.code.line(
        `providerVersionConstraint: '${resource.providerVersionConstraint}'`,
      );
    }

    this.code.close(`},`);
  }
}
