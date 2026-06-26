// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0

// Incrementally updates function-availability/functions-matrix.json with the
// function metadata of Terraform / OpenTofu releases that are not part of the
// matrix yet. For each new release the binary for the current machine is
// downloaded into a temp directory and `<binary> metadata functions -json` is
// executed (requires `curl` and `unzip` on the PATH).
//
// Run manually via `pnpm update-function-matrix` when a new Terraform or
// OpenTofu version is released. Afterwards re-run
// `pnpm generate-function-availability`.
//
// A full regeneration from scratch (plus the interactive HTML report) is done
// with the baseline sweep tooling in the open-constructs/cdktn-planning repo
// (RFCS/function-availability/scripts).

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FUNCTIONS_MATRIX_FILE, FunctionsMatrix, ProductName } from "./matrix";

const TERRAFORM_RELEASES_INDEX =
  "https://releases.hashicorp.com/terraform/index.json";
const OPENTOFU_RELEASES_INDEX = "https://get.opentofu.org/tofu/api.json";

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

function versionKey(version: string): number[] {
  return version.split(".").map(Number);
}

function compareVersions(a: string, b: string): number {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

async function fetchStableVersions(product: ProductName): Promise<string[]> {
  if (product === "terraform") {
    const res = await fetch(TERRAFORM_RELEASES_INDEX);
    if (!res.ok)
      throw new Error(`Fetching ${TERRAFORM_RELEASES_INDEX}: ${res.status}`);
    const index = (await res.json()) as { versions: Record<string, unknown> };
    return Object.keys(index.versions)
      .filter((v) => STABLE_VERSION.test(v))
      .sort(compareVersions);
  }
  const res = await fetch(OPENTOFU_RELEASES_INDEX);
  if (!res.ok)
    throw new Error(`Fetching ${OPENTOFU_RELEASES_INDEX}: ${res.status}`);
  const index = (await res.json()) as { versions: { id: string }[] };
  return index.versions
    .map((v) => v.id)
    .filter((v) => STABLE_VERSION.test(v))
    .sort(compareVersions);
}

function platformSuffix(): string {
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch as string];
  if (!arch || !["darwin", "linux"].includes(process.platform)) {
    throw new Error(
      `Unsupported platform ${process.platform}/${process.arch} for binary download`,
    );
  }
  return `${process.platform}_${arch}`;
}

function downloadUrl(product: ProductName, version: string): string {
  return product === "terraform"
    ? `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_${platformSuffix()}.zip`
    : `https://github.com/opentofu/opentofu/releases/download/v${version}/tofu_${version}_${platformSuffix()}.zip`;
}

function fetchFunctionMetadata(
  product: ProductName,
  version: string,
): Record<string, any> {
  const workDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `${product}-${version}-`),
  );
  try {
    const zip = path.join(workDir, "pkg.zip");
    const binary = path.join(
      workDir,
      product === "terraform" ? "terraform" : "tofu",
    );
    execSync(`curl -fsSL -o "${zip}" "${downloadUrl(product, version)}"`, {
      stdio: "pipe",
    });
    execSync(`unzip -oq "${zip}" -d "${workDir}"`, { stdio: "pipe" });
    const json = execSync(`"${binary}" metadata functions -json`, {
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
    return JSON.parse(json).function_signatures ?? {};
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function applyRelease(
  matrix: FunctionsMatrix,
  product: ProductName,
  version: string,
  signatures: Record<string, any>,
): void {
  // `core::` aliases (terraform >= 1.8, opentofu >= 1.7) mirror every builtin
  // 1:1 — folded out, consistent with build-matrix.py
  const names = Object.keys(signatures).filter((n) => !n.includes("::"));

  for (const name of names) {
    const signature = signatures[name];
    let entry = matrix.functions[name];
    if (!entry) {
      entry = {
        signature: {
          description: signature.description ?? "",
          return_type: signature.return_type,
          parameters: signature.parameters ?? [],
          variadic_parameter: signature.variadic_parameter ?? null,
        },
        products: { terraform: null, opentofu: null },
      };
      matrix.functions[name] = entry;
      console.log(`NEW function ${name} (${product} ${version})`);
    } else if (product === "terraform" || !entry.products.terraform) {
      // canonical signature precedence (same as build-matrix.py): terraform's
      // newest wording wins when the function exists in terraform, otherwise
      // opentofu's. Releases are applied in ascending version order.
      entry.signature = {
        description: signature.description ?? "",
        return_type: signature.return_type,
        parameters: signature.parameters ?? [],
        variadic_parameter: signature.variadic_parameter ?? null,
      };
    }

    const availability = entry.products[product];
    if (!availability) {
      entry.products[product] = {
        introduced: version,
        removed: null,
        gaps: [],
        count: 1,
      };
      console.log(`  ${name}: first ${product} release is ${version}`);
    } else {
      availability.count += 1;
      if (availability.removed) {
        // function came back after being marked removed — record the gap
        console.warn(
          `WARN ${name} reappeared in ${product} ${version} after removal at ${availability.removed}`,
        );
        availability.gaps.push(availability.removed);
        availability.removed = null;
      }
    }
  }

  // detect removals — by assumption this should never happen, so be loud
  const present = new Set(names);
  for (const [name, entry] of Object.entries(matrix.functions)) {
    const availability = entry.products[product];
    if (availability && !availability.removed && !present.has(name)) {
      console.warn(
        `WARN function ${name} disappeared in ${product} ${version} — recording removal; review functions-matrix.json`,
      );
      availability.removed = version;
    }
  }

  matrix.versions[product].push(version);
}

async function main() {
  const matrix: FunctionsMatrix = JSON.parse(
    fs.readFileSync(FUNCTIONS_MATRIX_FILE).toString(),
  );

  let updates = 0;
  for (const product of ["terraform", "opentofu"] as ProductName[]) {
    const known = new Set(matrix.versions[product]);
    const latestKnown =
      matrix.versions[product][matrix.versions[product].length - 1];
    const candidates = (await fetchStableVersions(product)).filter(
      // only move forward; historical backports of old minors are not part of the matrix
      (v) => !known.has(v) && compareVersions(v, latestKnown) > 0,
    );

    if (candidates.length === 0) {
      console.log(`${product}: up to date (latest ${latestKnown})`);
      continue;
    }

    for (const version of candidates) {
      console.log(`${product} ${version}: fetching function metadata...`);
      applyRelease(
        matrix,
        product,
        version,
        fetchFunctionMetadata(product, version),
      );
      updates++;
    }
  }

  if (updates === 0) {
    console.log("functions-matrix.json already covers all stable releases");
    return;
  }

  fs.writeFileSync(
    FUNCTIONS_MATRIX_FILE,
    JSON.stringify(matrix, null, 1) + "\n",
  );
  console.log(`updated ${FUNCTIONS_MATRIX_FILE} with ${updates} release(s)`);
  console.log(
    "next: run `pnpm generate-function-availability` (the HTML report is regenerated from the cdktn-planning sweep tooling)",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
