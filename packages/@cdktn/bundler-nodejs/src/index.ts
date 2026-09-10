// Copyright (c) OpenConstructs
// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { App, AssetType, TerraformAsset, Token } from "cdktn";
import { Construct } from "constructs";
import { unzipSync } from "fflate";
import type { InputOptions, OutputOptions } from "rolldown" with {
  "resolution-mode": "import",
};

// Inline options cross a JSON boundary into the native bundler process. Config
// modules remain available for plugins, callbacks and regular expressions.
type DataOptions<T> = T extends (...args: any[]) => any
  ? never
  : T extends RegExp
    ? never
    : T extends object
      ? { [K in keyof T]: DataOptions<T[K]> }
      : T;

/** Rolldown's built-in options, excluding settings managed by the construct. */
export type NodejsRolldownOptions = DataOptions<
  Omit<
    InputOptions,
    | "input"
    | "cwd"
    | "platform"
    | "preserveEntrySignatures"
    | "external"
    | "moduleTypes"
    | "tsconfig"
    | "transform"
    | "plugins"
    | "watch"
    | "devtools"
    | "onwarn"
    | "onLog"
  > & {
    transform?: Omit<
      NonNullable<InputOptions["transform"]>,
      "target" | "define"
    >;
    output?: Omit<
      OutputOptions,
      | "dir"
      | "file"
      | "format"
      | "entryFileNames"
      | "chunkFileNames"
      | "assetFileNames"
      | "minify"
      | "sourcemap"
      | "sourcemapPathTransform"
      | "keepNames"
      | "plugins"
    >;
  }
>;

/** An additional file or directory to include in the deployment ZIP. */
export interface CopyFile {
  readonly from: string;
  /** Path inside the ZIP. Use "." to copy a directory's contents to its root. */
  readonly to: string;
}

/** Optional controls over the native Rolldown build. */
export interface NodejsBundlingOptions {
  /** @default "esm" */
  readonly format?: "esm" | "cjs";
  /** @default true */
  readonly minify?: DataOptions<OutputOptions["minify"]>;
  /** Preserve function and class names when bundling and minifying. @default false */
  readonly keepNames?: boolean;
  /** Source maps: separate, inline, hidden, or disabled. @default true */
  readonly sourceMap?: OutputOptions["sourcemap"];
  /** Built-in file loaders, for example { ".sql": "text" }. */
  readonly moduleTypes?: InputOptions["moduleTypes"];
  /** Packages supplied by a Lambda layer or copyFiles, including their subpaths. */
  readonly externalModules?: string[];
  /** Compile-time substitutions. Values are JavaScript expressions. */
  readonly define?: Record<string, string>;
  /** A tsconfig path relative to projectRoot, or false to disable discovery. @default true */
  readonly tsconfig?: InputOptions["tsconfig"];
  /** JS/MJS/CJS module exporting Rolldown options, including plugins and output options. */
  readonly configFile?: string;
  /** Inline built-in resolution, transform, tree-shaking and output options. */
  readonly rolldownOptions?: NodejsRolldownOptions;
  readonly copyFiles?: CopyFile[];
}

/** Inputs for one provider-independent Node.js bundle operation. */
export interface NodejsBundleProps {
  /** TypeScript or JavaScript entry file, relative to projectRoot. */
  readonly entry: string;
  /** Export to expose from the bundle. @default "handler" */
  readonly handler?: string;
  /** Root for entry, configuration and copied-file paths. */
  readonly projectRoot: string;
  /** Node.js syntax target. @default "node24" */
  readonly target?: string;
  readonly bundling?: NodejsBundlingOptions;
}

/** The deterministic output of a Node.js bundle operation. */
export interface NodejsBundle {
  /** Complete deployment ZIP. */
  readonly archive: Uint8Array;
  /** Lambda-compatible module and export, for example "index.handler". */
  readonly handler: string;
  /** Hexadecimal SHA-256 of the exact ZIP bytes. */
  readonly assetHash: string;
  /** Base64 SHA-256 of the exact ZIP bytes. */
  readonly sourceCodeHash: string;
  /** Size of the complete ZIP in bytes. */
  readonly compressedSize: number;
  /** Total size of all ZIP entries in bytes. */
  readonly uncompressedSize: number;
}

/** Builds deterministic Node.js ZIPs without a construct or staging lifecycle. */
export class NodejsBundler {
  public bundle(props: NodejsBundleProps): NodejsBundle {
    validateBuildInput(props, "options");
    const projectRoot = path.resolve(props.projectRoot);
    const entry = path.resolve(projectRoot, props.entry);
    const handler = props.handler ?? "handler";
    if (!fs.existsSync(entry)) {
      throw new Error(`Node.js entry must be an existing local file: ${entry}`);
    }
    if (!fs.statSync(entry).isFile()) {
      throw new Error(`Node.js entry is not a file: ${entry}`);
    }
    if (!/^[A-Za-z_$][\w$]*$/.test(handler)) {
      throw new Error(
        `Node.js handler must be an exported identifier, received ${JSON.stringify(handler)}`,
      );
    }
    if (props.target && !/^node\d+(\.\d+)*$/.test(props.target)) {
      throw new Error(`Invalid Node.js target: ${props.target}`);
    }

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn-nodejs-"));
    let archive: Buffer;
    try {
      const resultFile = path.join(scratch, "archive.zip");
      const result = spawnSync(
        process.execPath,
        [path.join(__dirname, "../runner.mjs")],
        {
          input: JSON.stringify({
            ...props.bundling,
            entry,
            handler,
            projectRoot,
            target: props.target ?? "node24",
            resultFile,
          }),
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          timeout: 120_000,
          windowsHide: true,
        },
      );
      if (result.error || result.status !== 0) {
        throw new Error(
          `Failed to bundle ${entry}:\n${result.error?.message ?? result.stderr ?? result.signal}`,
        );
      }
      if (result.stderr) process.stderr.write(result.stderr);
      archive = fs.readFileSync(resultFile);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }

    let uncompressedSize = 0;
    unzipSync(archive, {
      filter: (file) => {
        uncompressedSize += file.originalSize;
        return false;
      },
    });
    const digest = createHash("sha256").update(archive).digest();
    return {
      archive,
      handler: `index.${handler}`,
      assetHash: digest.toString("hex"),
      sourceCodeHash: digest.toString("base64"),
      compressedSize: archive.byteLength,
      uncompressedSize,
    };
  }
}

/** Source code to bundle into a deployable Node.js asset. */
export interface NodejsAssetProps {
  /** TypeScript or JavaScript entry file, relative to projectRoot. */
  readonly entry: string;
  /** Export to expose from the bundle. @default "handler" */
  readonly handler?: string;
  /** Root for relative paths. @default directory containing cdktf.json, or cwd */
  readonly projectRoot?: string;
  /** Node.js syntax target. @default "node24" */
  readonly target?: string;
  readonly bundling?: NodejsBundlingOptions;
}

/** A deterministic ZIP built by Rolldown and staged by TerraformAsset. */
export class NodejsAsset extends TerraformAsset {
  /** Lambda-compatible module and export, for example "index.handler". */
  public readonly handler: string;
  /** Base64 SHA-256 of the exact ZIP bytes, suitable for source_code_hash. */
  public readonly sourceCodeHash: string;
  /** Size of the complete ZIP in bytes. */
  public readonly compressedSize: number;
  /** Total size of all ZIP entries in bytes, including source maps and copied files. */
  public readonly uncompressedSize: number;

  constructor(scope: Construct, id: string, props: NodejsAssetProps) {
    const projectRoot = resolveProjectRoot(scope, props.projectRoot);
    validateBuildInput(props, "options", new Set(), (value) =>
      Token.isUnresolved(value),
    );
    const bundle = new NodejsBundler().bundle({
      entry: props.entry,
      handler: props.handler,
      projectRoot,
      target: props.target,
      bundling: props.bundling,
    });
    // Keep immutable source artifacts within the app output, so repeated synths
    // can use TerraformAsset's normal staging without leaked temporary trees.
    const sourcePath = path.resolve(
      App.of(scope).outdir,
      ".nodejs-assets",
      bundle.assetHash,
      "archive.zip",
    );
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, bundle.archive);
    super(scope, id, {
      path: sourcePath,
      type: AssetType.FILE,
      assetHash: bundle.assetHash,
    });
    this.handler = bundle.handler;
    this.sourceCodeHash = bundle.sourceCodeHash;
    this.compressedSize = bundle.compressedSize;
    this.uncompressedSize = bundle.uncompressedSize;
  }
}

function validateBuildInput(
  value: unknown,
  name: string,
  parents = new Set<object>(),
  isUnresolved: (value: unknown) => boolean = () => false,
): void {
  if (isUnresolved(value)) {
    throw new Error(
      `Node.js build option ${name} contains an unresolved Terraform value. Build inputs must be known during synthesis. Pass deployment-time values to the consuming construct or resource instead.`,
    );
  }
  if (value === null || value === undefined) return;
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`Node.js build option ${name} must be a finite number.`);
  }
  if (["string", "boolean", "number"].includes(typeof value)) return;
  if (
    typeof value !== "object" ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(
      `Node.js build option ${name} must be JSON data. Put plugins, callbacks and regular expressions in bundling.configFile.`,
    );
  }
  if (parents.has(value))
    throw new Error(
      `Node.js build option ${name} contains a circular reference.`,
    );
  parents.add(value);
  for (const [key, child] of Object.entries(value)) {
    validateBuildInput(key, `${name} key`, parents, isUnresolved);
    validateBuildInput(child, `${name}.${key}`, parents, isUnresolved);
  }
  parents.delete(value);
}

function resolveProjectRoot(scope: Construct, explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const configPath = scope.node.tryGetContext("cdktfJsonPath");
  if (configPath) return path.dirname(path.resolve(configPath));
  let directory = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(directory, "cdktf.json"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return process.cwd();
    directory = parent;
  }
}
