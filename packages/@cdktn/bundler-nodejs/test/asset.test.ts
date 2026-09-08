// Copyright (c) OpenConstructs
// SPDX-License-Identifier: MPL-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { App, TerraformStack } from "cdktn";
import { NodejsAsset, NodejsAssetProps } from "../src";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn bundle & spaces-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(name: string, content: string, directory = root) {
  const file = path.join(directory, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function synth(props: Partial<NodejsAssetProps> = {}, directory = root) {
  const app = new App({ outdir: path.join(directory, "out") });
  const stack = new TerraformStack(app, "test");
  const asset = new NodejsAsset(stack, "Code", {
    entry: "src/handler.ts",
    projectRoot: directory,
    ...props,
  });
  app.synth();
  const zip = fs.readFileSync(path.join(app.outdir, "stacks/test", asset.path));
  const files = unzipSync(zip);
  return { asset, zip, files, app };
}

function invoke(
  files: Record<string, Uint8Array>,
  format = "esm",
  handler = "handler",
) {
  const directory = fs.mkdtempSync(path.join(root, "invoke-"));
  for (const [name, data] of Object.entries(files))
    write(name, Buffer.from(data).toString(), directory);
  const url = pathToFileURL(
    path.join(directory, format === "esm" ? "index.mjs" : "index.cjs"),
  ).href;
  const load =
    format === "esm"
      ? `await import(${JSON.stringify(url)})`
      : `createRequire(import.meta.url)(fileURLToPath(${JSON.stringify(url)}))`;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {createRequire} from "node:module"; import {fileURLToPath} from "node:url"; const m = ${load}; console.log(JSON.stringify(await m[${JSON.stringify(handler)}]({name:"Ada"})));`,
      ],
      { encoding: "utf8" },
    ),
  );
}

test("bundles TypeScript, JSON, path aliases, CommonJS dependencies and Node builtins into an executable ESM ZIP", () => {
  write("package.json", '{"type":"module"}');
  write(
    "tsconfig.json",
    '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}}}',
  );
  write("src/data.json", '{"prefix":"Hello"}');
  write(
    "src/message.ts",
    'import data from "./data.json"; export const prefix: string = data.prefix;',
  );
  write(
    "node_modules/greeting/package.json",
    '{"name":"greeting","main":"index.cjs"}',
  );
  write(
    "node_modules/greeting/index.cjs",
    'const path = require("node:path"); module.exports = value => path.basename(value);',
  );
  write(
    "src/handler.ts",
    'import greet from "greeting"; import {prefix} from "@app/message"; export async function handler(event: {name:string}) {return `${prefix} ${greet(event.name)}`;} export const unused = "REMOVE_UNUSED_EXPORT";',
  );
  const { asset, zip, files } = synth();
  expect(invoke(files)).toBe("Hello Ada");
  expect(Buffer.from(files["index.mjs"]).toString()).not.toContain(
    "REMOVE_UNUSED_EXPORT",
  );
  expect(files["index.mjs.map"]).toBeDefined();
  expect(asset.sourceCodeHash).toBe(
    createHash("sha256").update(zip).digest("base64"),
  );
  expect(asset.assetHash).toBe(createHash("sha256").update(zip).digest("hex"));
});

test.each(["esm", "cjs"] as const)(
  "supports a CommonJS handler with %s output",
  (format) => {
    write(
      "src/handler.cjs",
      "exports.run = async event => ({hello:event.name});",
    );
    const { files, asset } = synth({
      entry: "src/handler.cjs",
      handler: "run",
      bundling: { format },
    });
    expect(asset.handler).toBe("index.run");
    expect(invoke(files, format, "run")).toEqual({ hello: "Ada" });
  },
);

test("preserves lazy dynamic imports and ESM top-level await", () => {
  write("src/lazy.ts", "globalThis.counter += 1; export const value = 7;");
  write(
    "src/handler.ts",
    'await Promise.resolve(); globalThis.counter = 0; export async function handler() {const before = globalThis.counter; const {value} = await import("./lazy"); return {before,after:globalThis.counter,value};}',
  );
  const { files } = synth();
  expect(Object.keys(files).some((name) => name.startsWith("chunks/"))).toBe(
    true,
  );
  expect(invoke(files)).toEqual({ before: 0, after: 1, value: 7 });
});

test("ZIP identity survives checkout relocation, timestamps and timezones", () => {
  const source = 'export async function handler() {return "same";}';
  write("src/handler.ts", source);
  const first = synth();
  const moved = path.join(root, "moved checkout");
  write("src/handler.ts", source, moved);
  fs.utimesSync(path.join(moved, "src/handler.ts"), 12345, 12345);
  const oldTimezone = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Honolulu";
    expect(synth({}, moved).zip).toEqual(first.zip);
  } finally {
    if (oldTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = oldTimezone;
  }
});

test("rebuilds transitive dependencies and ignores unrelated source changes", () => {
  write("src/value.ts", 'export const value = "one";');
  write(
    "src/handler.ts",
    'import {value} from "./value"; export const handler = () => value;',
  );
  const first = synth();
  write("unrelated.txt", "irrelevant");
  expect(synth().asset.assetHash).toBe(first.asset.assetHash);
  write("src/value.ts", 'export const value = "two";');
  const changed = synth();
  expect(changed.asset.assetHash).not.toBe(first.asset.assetHash);
  expect(invoke(changed.files)).toBe("two");
});

test("supports explicitly external packages, compile-time defines and copied assets", () => {
  write(
    "src/handler.ts",
    'import {value} from "provided/subpath"; export const handler = () => `${MODE}:${value}`;',
  );
  write(
    "provided/package.json",
    '{"name":"provided","type":"module","exports":{"./subpath":"./subpath.js"}}',
  );
  write("provided/subpath.js", "export const value = 42;");
  const { files } = synth({
    bundling: {
      externalModules: ["provided"],
      define: { MODE: '"production"' },
      copyFiles: [{ from: "provided", to: "node_modules/provided" }],
    },
  });
  expect(invoke(files)).toBe("production:42");
});

test("loads Rollup-style plugins and hashes their output and copied content", () => {
  write("src/handler.ts", 'export const handler = () => "ok";');
  write(
    "config.mjs",
    'export default {plugins:[{name:"fixture",generateBundle(){this.emitFile({type:"asset",fileName:"plugin.txt",source:"plugin output"});}}]};',
  );
  write("extra.txt", "first");
  const props = {
    bundling: {
      configFile: "config.mjs",
      copyFiles: [{ from: "extra.txt", to: "extra.txt" }],
    },
  };
  const first = synth(props);
  expect(Buffer.from(first.files["plugin.txt"]).toString()).toBe(
    "plugin output",
  );
  write("extra.txt", "second");
  expect(synth(props).asset.assetHash).not.toBe(first.asset.assetHash);
});

test("supports disabling minification and source maps", () => {
  write(
    "src/handler.ts",
    'export function handler() { const readableVariable = "hello"; return readableVariable; }',
  );
  const { files } = synth({ bundling: { sourceMap: false, minify: false } });
  expect(Object.keys(files)).toEqual(["index.mjs"]);
  expect(invoke(files)).toBe("hello");
});

test("missing imports, missing exports and syntax errors fail before deployment", () => {
  write(
    "src/handler.ts",
    'import value from "missing-package"; export const handler = () => value;',
  );
  expect(() => synth()).toThrow(/missing-package/);
  write("src/handler.ts", "export const wrong = () => 1;");
  expect(() => synth()).toThrow(/handler/);
  write("src/handler.ts", "export const handler = =>");
  expect(() => synth()).toThrow(/Failed to bundle/);
});

test("rejects missing files, malformed export names, traversal and output collisions", () => {
  expect(() => synth()).toThrow(/existing local file/);
  write("src/handler.ts", "export const handler = () => 1;");
  expect(() => synth({ handler: "file.handler" })).toThrow(
    /exported identifier/,
  );
  write("extra.txt", "data");
  expect(() =>
    synth({
      bundling: { copyFiles: [{ from: "extra.txt", to: "../escape" }] },
    }),
  ).toThrow(/inside the archive/);
  expect(() =>
    synth({
      bundling: { copyFiles: [{ from: "extra.txt", to: "index.mjs" }] },
    }),
  ).toThrow(/Duplicate ZIP/);
});

test("resolves relative entries from the cdktf.json context and can synthesize twice", () => {
  write("src/handler.ts", "export const handler = () => 1;");
  const app = new App({
    outdir: path.join(root, "out"),
    context: { cdktfJsonPath: path.join(root, "cdktf.json") },
  });
  const asset = new NodejsAsset(new TerraformStack(app, "test"), "Code", {
    entry: "src/handler.ts",
  });
  app.synth();
  const staged = path.join(app.outdir, "stacks/test", asset.path);
  const first = fs.readFileSync(staged);
  app.synth();
  expect(fs.readFileSync(staged)).toEqual(first);
});
