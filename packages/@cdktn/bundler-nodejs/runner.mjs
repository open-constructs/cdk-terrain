// Copyright (c) OpenConstructs
// SPDX-License-Identifier: MPL-2.0
// An async native bundler behind CDKTN's synchronous construct API. No shell,
// global bundler, compiler installation, Docker, or execution of handler code.
import { readFileSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { rolldown } from "rolldown";
import { zipSync } from "fflate";

try {
  const request = JSON.parse(readFileSync(0, "utf8"));
  const format = request.format ?? "esm";
  const extension = format === "esm" ? "mjs" : "cjs";
  let custom = {};
  if (request.configFile) {
    custom = (
      await import(
        pathToFileURL(path.resolve(request.projectRoot, request.configFile))
          .href
      )
    ).default;
    if (!custom || typeof custom !== "object" || Array.isArray(custom)) {
      throw new Error(
        "The bundling config must default-export one Rolldown options object.",
      );
    }
  }
  const { output: customOutput, ...customInput } = custom;
  if (Array.isArray(customOutput))
    throw new Error("The bundling config must have one output options object.");
  const { output: inlineOutput, ...inlineInput } =
    request.rolldownOptions ?? {};
  const tsconfig = request.tsconfig ?? customInput.tsconfig;
  const facade = "\0cdktn-nodejs-entry";
  const external = request.externalModules ?? [];
  const bundle = await rolldown({
    ...customInput,
    ...inlineInput,
    cwd: request.projectRoot,
    input: facade,
    platform: "node",
    preserveEntrySignatures: "strict",
    tsconfig:
      typeof tsconfig === "string"
        ? path.resolve(request.projectRoot, tsconfig)
        : tsconfig,
    // Let the native resolver match package names and subpaths without calling
    // JavaScript for every import. Escape package names as literal strings.
    external: external.map((name) => {
      const wildcard = name.endsWith("/*");
      const prefix = (wildcard ? name.slice(0, -1) : name).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      return new RegExp(`^${prefix}${wildcard ? "" : "(?:/|$)"}`);
    }),
    moduleTypes: { ...customInput.moduleTypes, ...request.moduleTypes },
    transform: {
      ...customInput.transform,
      ...inlineInput.transform,
      target: request.target,
      define: { ...customInput.transform?.define, ...request.define },
    },
    plugins: [
      {
        name: "cdktn-nodejs-entry",
        resolveId: {
          filter: { id: /^(?:\0cdktn-nodejs-entry|cdktn:user-entry)$/ },
          handler: (id) => (id === facade ? facade : request.entry),
        },
        load: {
          filter: { id: /^\0cdktn-nodejs-entry$/ },
          handler: () =>
            `export { ${request.handler} } from "cdktn:user-entry";`,
        },
      },
      ...(customInput.plugins ?? []),
    ],
    onwarn(warning, warn) {
      // A misspelled dependency must not silently become a broken deployed import.
      if (warning.code === "UNRESOLVED_IMPORT")
        throw new Error(warning.message);
      if (customInput.onwarn) customInput.onwarn(warning, warn);
      else warn(warning);
    },
  });
  let output;
  try {
    ({ output } = await bundle.generate({
      ...customOutput,
      ...inlineOutput,
      dir: request.projectRoot,
      file: undefined,
      format,
      entryFileNames: `index.${extension}`,
      chunkFileNames: `chunks/[name]-[hash].${extension}`,
      assetFileNames: "assets/[name]-[hash][extname]",
      minify: request.minify ?? customOutput?.minify ?? true,
      keepNames: request.keepNames ?? customOutput?.keepNames,
      sourcemap: request.sourceMap ?? customOutput?.sourcemap ?? true,
      sourcemapPathTransform: (source) => source.split(path.sep).join("/"),
      polyfillRequire:
        inlineOutput?.polyfillRequire ?? customOutput?.polyfillRequire ?? true,
    }));
  } finally {
    await bundle.close();
  }

  const files = new Map();
  function add(name, data) {
    const normalized = path.posix.normalize(name);
    if (
      name.includes("\\") ||
      name.includes(":") ||
      normalized === "." ||
      normalized.startsWith("/") ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      throw new Error(`ZIP destination must stay inside the archive: ${name}`);
    }
    if (files.has(normalized))
      throw new Error(`Duplicate ZIP destination: ${normalized}`);
    files.set(normalized, typeof data === "string" ? Buffer.from(data) : data);
  }
  for (const file of output)
    add(file.fileName, file.type === "chunk" ? file.code : file.source);
  function copy(source, destination) {
    const stat = lstatSync(source);
    if (stat.isSymbolicLink())
      throw new Error(
        `copyFiles does not follow symlinks: ${source}. Copy a prepared dependency directory instead.`,
      );
    if (stat.isDirectory()) {
      for (const name of readdirSync(source).sort())
        copy(path.join(source, name), path.posix.join(destination, name));
    } else if (stat.isFile()) add(destination, readFileSync(source));
    else
      throw new Error(
        `copyFiles requires regular files or directories: ${source}`,
      );
  }
  for (const file of request.copyFiles ?? [])
    copy(path.resolve(request.projectRoot, file.from), file.to);

  const zipped = Object.create(null);
  for (const name of [...files.keys()].sort()) {
    zipped[name] = [files.get(name), { os: 3, attrs: (0o100644 << 16) >>> 0 }];
  }
  // A fixed local date produces the same DOS timestamp in every timezone.
  writeFileSync(
    request.resultFile,
    zipSync(zipped, { level: 9, mtime: new Date(1980, 0, 1, 0, 0, 0) }),
  );
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
