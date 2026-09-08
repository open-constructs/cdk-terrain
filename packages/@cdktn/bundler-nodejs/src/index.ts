// Copyright (c) OpenConstructs
// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { App, AssetType, TerraformAsset, Token } from "cdktn";
import { Construct } from "constructs";

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
  readonly minify?: boolean;
  /** Include source maps and their original sources. @default true */
  readonly sourceMap?: boolean;
  /** Packages supplied by a Lambda layer or copyFiles, including their subpaths. */
  readonly externalModules?: string[];
  /** Compile-time substitutions. Values are JavaScript expressions. */
  readonly define?: Record<string, string>;
  /** Optional tsconfig path, relative to projectRoot. Otherwise discovered by Rolldown. */
  readonly tsconfig?: string;
  /** JS/MJS/CJS module exporting Rolldown options, including plugins and output options. */
  readonly configFile?: string;
  readonly copyFiles?: CopyFile[];
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

  constructor(scope: Construct, id: string, props: NodejsAssetProps) {
    const projectRoot = resolveProjectRoot(scope, props.projectRoot);
    const entry = path.resolve(projectRoot, props.entry);
    const handler = props.handler ?? "handler";
    if (Token.isUnresolved(props.entry) || !fs.existsSync(entry)) {
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

    // Output hashing needs a real build. Never reuse a source-only cache: imports,
    // lockfiles, package exports, plugins and copied files can all change output.
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

    const digest = createHash("sha256").update(archive).digest();
    const assetHash = digest.toString("hex");
    // Keep immutable source artifacts within the app output, so repeated synths
    // can use TerraformAsset's normal staging without leaked temporary trees.
    const sourcePath = path.resolve(
      App.of(scope).outdir,
      ".nodejs-assets",
      assetHash,
      "archive.zip",
    );
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, archive);
    super(scope, id, { path: sourcePath, type: AssetType.FILE, assetHash });
    this.handler = `index.${handler}`;
    this.sourceCodeHash = digest.toString("base64");
  }
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
