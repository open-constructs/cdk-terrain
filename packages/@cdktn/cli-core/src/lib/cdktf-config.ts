// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import * as fs from "fs";
import {
  Language,
  Errors,
  CONFIG_DEFAULTS,
  TerraformDependencyConstraint,
  findConfigAbove,
} from "@cdktn/commons";
import path from "path";
import { logger } from "@cdktn/commons";

// TODO: move this to @cdktn/commons
// tracked here https://github.com/hashicorp/terraform-cdk/issues/1814
export class CdktfConfig {
  constructor(private cdktfConfigPath: string) {}

  private readCdktfConfig(): Record<string, unknown> {
    const cdktfConfig = JSON.parse(
      fs.readFileSync(this.cdktfConfigPath, "utf-8"),
    );
    if (typeof cdktfConfig !== "object" || cdktfConfig === null) {
      throw Errors.External(
        "cdktf.json is malformed. The root must be a JSON object.",
      ); // TODO: define a schema and validate against it
    }
    return cdktfConfig;
  }

  private writeCdktfConfig(cdktfConfig: Record<string, unknown>) {
    const cdktfConfigString = JSON.stringify(cdktfConfig, null, 2);
    fs.writeFileSync(this.cdktfConfigPath, cdktfConfigString);
  }

  private getProperty(property: string): unknown {
    const cdktfConfig = this.readCdktfConfig();
    return cdktfConfig[property] || (CONFIG_DEFAULTS as any)[property];
  }

  public get language(): Language {
    const rawLanguage = this.getProperty("language");
    const language = Object.values(Language).find(
      (value) => value === rawLanguage,
    );
    if (!language)
      throw Errors.Usage(
        `${rawLanguage} is not a valid language. It must be one of ${Object.values(
          Language,
        )}`,
      );

    return language;
  }

  public get codeMakerOutput(): string {
    return this.getProperty("codeMakerOutput") as string;
  }

  public get terraformProviders(): (TerraformDependencyConstraint | string)[] {
    const providers = this.getProperty("terraformProviders");
    if (!Array.isArray(providers)) return [];
    return providers;
  }

  public get terraformModules(): (TerraformDependencyConstraint | string)[] {
    const modules = this.getProperty("terraformModules");
    if (!Array.isArray(modules)) return [];
    return modules;
  }

  public writeTerraformProviders(
    providers: (TerraformDependencyConstraint | string)[],
  ) {
    const cdktfConfig = this.readCdktfConfig();
    cdktfConfig.terraformProviders = providers;
    this.writeCdktfConfig(cdktfConfig);
  }

  public get projectDirectory(): string {
    return path.dirname(this.cdktfConfigPath);
  }

  public static read(path: string = process.cwd()): CdktfConfig {
    const cdktfConfigPath = findConfigAbove(path);
    if (!cdktfConfigPath) {
      throw Errors.External(
        "Could not find cdktn.json or cdktf.json. Make sure there is a cdktn.json (or cdktf.json) file in the current directory or one of its parents.",
      );
    }
    logger.trace(`config found at ${cdktfConfigPath}`);

    return new CdktfConfig(cdktfConfigPath);
  }
}
