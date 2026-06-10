// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import chalk from "chalk";
import { GetOptions } from "@cdktn/provider-generator";
import {
  IsErrorType,
  Language,
  LanguageOptions,
  sendTelemetry,
  TerraformDependencyConstraint,
} from "@cdktn/commons";
import { get, GetStatus } from "@cdktn/cli-core";
import { StreamRenderer } from "../helper/tty-stream";

/** Options accepted by {@link runGet}. */
export interface GetConfig {
  codeMakerOutput: string;
  language: Language;
  languageOptions?: LanguageOptions;
  constraints: TerraformDependencyConstraint[];
  parallelism: number;
  force?: boolean;
  silent?: boolean;
  providerSchemaCachePath?: string;
}

/**
 * Drive a `cdktn get` invocation: generate language-specific constructs
 * from provider/module constraints. Uses an `ora` spinner (no log streaming
 * required for this command) and emits a final summary line on success.
 *
 * @param config - Get options including target language and constraints.
 *   When `silent: true`, no spinner or summary is printed and the function
 *   only throws on error.
 * @returns Promise that resolves when generation completes, rejects on
 *   failure (wrapped in an `Error`, with the original stack logged unless
 *   the underlying error is a Usage error).
 */
export async function runGet({
  codeMakerOutput,
  language,
  constraints,
  parallelism,
  force,
  silent = false,
  providerSchemaCachePath,
  languageOptions,
}: GetConfig): Promise<void> {
  const constructsOptions: GetOptions = {
    codeMakerOutput,
    targetLanguage: language,
    jsiiParallelism: parallelism,
    languageOptions,
  };

  const stream = silent ? undefined : new StreamRenderer();
  stream?.start();
  stream?.setBar(`${GetStatus.STARTING}...`, { spinner: true });

  try {
    await get({
      constraints,
      constructsOptions,
      cleanDirectory: force,
      onUpdate: (status) => {
        stream?.setBar(`${status}...`, { spinner: true });
      },
      providerSchemaCachePath,
      reportTelemetry: async (payload) =>
        sendTelemetry("get", {
          language: payload.targetLanguage,
          ...payload.trackingPayload,
        }),
    });
  } catch (e: any) {
    stream?.stop();
    if (!IsErrorType(e, "Usage")) {
      console.error(e);
    }
    throw new Error(e);
  }

  stream?.stop();

  if (silent) return;

  console.log(
    `Generated ${chalk.green(language)} constructs in the output directory: ${chalk.bold(codeMakerOutput)}`,
  );
  if (language === Language.GO) {
    console.log(
      `\nThe generated code depends on ${chalk.cyan("jsii-runtime-go")}. If you haven't yet installed it, you can run ${chalk.blueBright("go mod tidy")} to automatically install it.`,
    );
  }
}
