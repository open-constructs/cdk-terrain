// Copyright (c) OpenConstructs
// SPDX-License-Identifier: MPL-2.0
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { App, TerraformStack, TerraformVariable } from "cdktn";
import { NodejsAsset, NodejsAssetProps, NodejsBundler } from "../src";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cdktn bundle & spaces-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(name: string, content: string | Uint8Array, directory = root) {
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
    write(name, data, directory);
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

test("bundles without a construct or staging lifecycle", () => {
  write(
    "src/handler.ts",
    "export const handler = ({name}: {name: string}) => `Hello ${name}`;",
  );
  const bundle = new NodejsBundler().bundle({
    entry: "src/handler.ts",
    projectRoot: root,
    target: "node24",
  });
  const files = unzipSync(bundle.archive);

  expect(invoke(files)).toBe("Hello Ada");
  expect(bundle.handler).toBe("index.handler");
  expect(bundle.assetHash).toBe(
    createHash("sha256").update(bundle.archive).digest("hex"),
  );
  expect(bundle.sourceCodeHash).toBe(
    createHash("sha256").update(bundle.archive).digest("base64"),
  );
  expect(bundle.compressedSize).toBe(bundle.archive.byteLength);
  expect(bundle.uncompressedSize).toBe(
    Object.values(files).reduce((total, file) => total + file.byteLength, 0),
  );
});

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
  expect(asset.compressedSize).toBe(zip.byteLength);
  expect(asset.uncompressedSize).toBe(
    Object.values(files).reduce((total, file) => total + file.byteLength, 0),
  );
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

test.each(["inline", "hidden"] as const)(
  "uses Rolldown's native %s source map mode",
  (sourceMap) => {
    write("src/handler.ts", "export const handler = () => 1;");
    const { files } = synth({ bundling: { sourceMap } });
    expect(invoke(files)).toBe(1);
    const code = Buffer.from(files["index.mjs"]).toString();
    if (sourceMap === "inline") {
      expect(code).toContain("sourceMappingURL=data:application/json");
      expect(files["index.mjs.map"]).toBeUndefined();
    } else {
      expect(code).not.toContain("sourceMappingURL");
      expect(files["index.mjs.map"]).toBeDefined();
    }
  },
);

test("honors native config-file defaults and explicit boolean overrides", () => {
  write("src/handler.ts", "export const handler = () => 1;");
  write("tsconfig.json", "{invalid configuration");
  write(
    "config.mjs",
    "export default {tsconfig:false,output:{minify:false,sourcemap:false}};",
  );
  const inherited = synth({ bundling: { configFile: "config.mjs" } });
  expect(invoke(inherited.files)).toBe(1);
  expect(inherited.files["index.mjs.map"]).toBeUndefined();
  const overridden = synth({
    bundling: { configFile: "config.mjs", minify: true, sourceMap: true },
  });
  expect(overridden.files["index.mjs.map"]).toBeDefined();
  expect(overridden.files["index.mjs"].byteLength).toBeLessThan(
    inherited.files["index.mjs"].byteLength,
  );
  expect(invoke(synth({ bundling: { tsconfig: false } }).files)).toBe(1);
  expect(() =>
    synth({ bundling: { configFile: "config.mjs", tsconfig: true } }),
  ).toThrow(/tsconfig/);
});

test.each(["esm", "cjs"] as const)(
  "preserves class and function names in minified %s output",
  (format) => {
    write(
      "src/handler.ts",
      "class RegisteredService {} function registeredAction() {} export const handler = () => [RegisteredService.name, registeredAction.name];",
    );
    const { files } = synth({ bundling: { format, keepNames: true } });
    expect(invoke(files, format)).toEqual([
      "RegisteredService",
      "registeredAction",
    ]);
  },
);

test("uses native text, binary and asset loaders and counts every packaged byte", () => {
  write("src/query.sql", "SELECT 'café';");
  write("src/payload.bin", new Uint8Array([0, 128, 255]));
  write("src/template.template", "packaged template");
  write("extra.txt", "copied contents");
  write(
    "src/handler.ts",
    'import { readFileSync } from "node:fs"; import query from "./query.sql"; import data from "./payload.bin"; import template from "./template.template"; export const handler = () => ({ query, data: Array.from(data), template: readFileSync(new URL(template, import.meta.url), "utf8") });',
  );
  const { asset, zip, files } = synth({
    bundling: {
      moduleTypes: { ".sql": "text", ".bin": "binary", ".template": "asset" },
      copyFiles: [{ from: "extra.txt", to: "extra.txt" }],
    },
  });
  expect(invoke(files)).toEqual({
    query: "SELECT 'café';",
    data: [0, 128, 255],
    template: "packaged template",
  });
  expect(Object.keys(files).some((file) => file.startsWith("assets/"))).toBe(
    true,
  );
  expect(asset.compressedSize).toBe(zip.byteLength);
  expect(asset.uncompressedSize).toBe(
    Object.values(files).reduce((total, file) => total + file.byteLength, 0),
  );
});

test("passes built-in aliases, export conditions, minifier and output options to Rolldown", () => {
  write("src/value.ts", 'export const value = "aliased";');
  write(
    "node_modules/conditional/package.json",
    JSON.stringify({
      name: "conditional",
      type: "module",
      exports: { lambda: "./lambda.js", default: "./default.js" },
    }),
  );
  write("node_modules/conditional/lambda.js", 'export default "lambda";');
  write("node_modules/conditional/default.js", 'export default "default";');
  write(
    "src/handler.ts",
    'import {value} from "@value"; import condition from "conditional"; export const handler = () => [value, condition, BANNER];',
  );
  const { files } = synth({
    bundling: {
      minify: { compress: true, mangle: false },
      rolldownOptions: {
        resolve: {
          alias: { "@value": path.join(root, "src/value.ts") },
          conditionNames: ["lambda", "node", "import", "default"],
        },
        output: {
          banner: 'const BANNER = "built-in";',
          sourcemapExcludeSources: true,
        },
      },
    },
  });
  expect(invoke(files)).toEqual(["aliased", "lambda", "built-in"]);
  expect(
    JSON.parse(Buffer.from(files["index.mjs.map"]).toString()).sourcesContent,
  ).toBeUndefined();
});

test("uses native JSX transforms and injected imports without plugins", () => {
  write("src/format.ts", 'export const prefix = "native";');
  write(
    "src/handler.tsx",
    "function h(tag, props, child) { return { tag, child, prefix: PREFIX }; } export const handler = () => <h1>hello</h1>;",
  );
  const { files } = synth({
    entry: "src/handler.tsx",
    bundling: {
      rolldownOptions: {
        transform: {
          jsx: { runtime: "classic", pragma: "h" },
          inject: { PREFIX: [path.join(root, "src/format.ts"), "prefix"] },
        },
      },
    },
  });
  expect(invoke(files)).toEqual({
    tag: "h1",
    child: "hello",
    prefix: "native",
  });
});

test("explicit keepNames false overrides a configuration module", () => {
  write(
    "src/handler.ts",
    "class RegisteredService {} export const handler = () => RegisteredService.name;",
  );
  write("config.mjs", "export default {output:{keepNames:true}};");
  expect(invoke(synth({ bundling: { configFile: "config.mjs" } }).files)).toBe(
    "RegisteredService",
  );
  expect(
    invoke(
      synth({ bundling: { configFile: "config.mjs", keepNames: false } }).files,
    ),
  ).not.toBe("RegisteredService");
});

test("merges native loaders with config modules and gives explicit options precedence", () => {
  write("src/query.sql", "query");
  write("src/template.html", "template");
  write(
    "src/handler.ts",
    'import query from "./query.sql"; import template from "./template.html"; class RegisteredService {} export const handler = () => [query, template, RegisteredService.name, BANNER, FOOTER];',
  );
  write(
    "config.mjs",
    `export default {
      moduleTypes: { ".html": "text", ".sql": "empty" },
      output: { keepNames: false, banner: 'const BANNER = "config";', footer: 'const FOOTER = "config footer";' },
      plugins: [{ name: "extra", generateBundle() { this.emitFile({ type: "asset", fileName: "plugin.txt", source: "plugin output" }); } }],
    };`,
  );
  const { files } = synth({
    bundling: {
      configFile: "config.mjs",
      keepNames: true,
      moduleTypes: { ".sql": "text" },
      rolldownOptions: { output: { banner: 'const BANNER = "inline";' } },
    },
  });
  expect(invoke(files)).toEqual([
    "query",
    "template",
    "RegisteredService",
    "inline",
    "config footer",
  ]);
  expect(Buffer.from(files["plugin.txt"]).toString()).toBe("plugin output");
});

test.each<[string, (token: string) => Partial<NodejsAssetProps>]>([
  ["entry", (token) => ({ entry: token })],
  ["projectRoot", (token) => ({ projectRoot: token })],
  ["handler", (token) => ({ handler: token })],
  ["target", (token) => ({ target: token })],
  [
    "bundling.define.API_URL",
    (token) => ({ bundling: { define: { API_URL: JSON.stringify(token) } } }),
  ],
  [
    "bundling.externalModules.0",
    (token) => ({ bundling: { externalModules: [token] } }),
  ],
  [
    "bundling.copyFiles.0.to",
    (token) => ({
      bundling: { copyFiles: [{ from: "extra.txt", to: token }] },
    }),
  ],
  [
    "bundling.rolldownOptions.resolve.alias.@api",
    (token) => ({
      bundling: { rolldownOptions: { resolve: { alias: { "@api": token } } } },
    }),
  ],
  [
    "bundling.moduleTypes key",
    (token) => ({ bundling: { moduleTypes: { [token]: "text" } } }),
  ],
])(
  "rejects unresolved Terraform values in %s before starting a build",
  (name, options) => {
    const inputs = new TerraformStack(
      new App({ outdir: path.join(root, "inputs") }),
      "inputs",
    );
    const token = new TerraformVariable(inputs, "api_url", { type: "string" })
      .stringValue;
    write("src/handler.ts", "export const handler = () => API_URL;");
    expect(() => synth(options(token))).toThrow(
      `Node.js build option options.${name} contains an unresolved Terraform value.`,
    );
    expect(() => synth(options(token))).toThrow(
      /consuming construct or resource/,
    );
  },
);

test.each([() => "banner", /banner/])(
  "rejects executable inline options instead of silently serializing them",
  (banner) => {
    write("src/handler.ts", "export const handler = () => 1;");
    expect(() =>
      synth({
        bundling: {
          rolldownOptions: { output: { banner: banner as unknown as string } },
        },
      }),
    ).toThrow(/bundling.configFile/);
  },
);

test.each(["@provided/*", "provided.name", "provided+name"])(
  "native external matching preserves %s and its subpaths",
  (name) => {
    const packageName = name.endsWith("/*")
      ? `${name.slice(0, -1)}package`
      : name;
    write(
      "src/handler.ts",
      `import value from ${JSON.stringify(`${packageName}/subpath`)}; export const handler = () => value;`,
    );
    const { files } = synth({ bundling: { externalModules: [name] } });
    expect(Buffer.from(files["index.mjs"]).toString()).toContain(
      `${packageName}/subpath`,
    );
  },
);

test("native external matching does not match similarly named packages", () => {
  write(
    "src/handler.ts",
    'import value from "providedXname/subpath"; export const handler = () => value;',
  );
  expect(() =>
    synth({ bundling: { externalModules: ["provided.name"] } }),
  ).toThrow(/providedXname/);
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
