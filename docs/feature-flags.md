# Feature Flags

CDK Terrain uses feature flags to introduce behavior we want as the future
default without breaking existing projects. Flags are plain context keys read
from `cdktf.json` (or the `App` constructor's `context` option):

```json
{
  "context": {
    "canonicalAssetHashes": "true"
  }
}
```

The lifecycle, defined in
[`packages/cdktn/src/features.ts`](../packages/cdktn/src/features.ts):

- `cdktn init` writes every current `FUTURE_FLAGS` entry into new projects'
  `cdktf.json`, so **new projects always get the future behavior**.
- Existing projects keep the old behavior until they **opt in** by adding the
  context key themselves.
- At the next major release the flagged behavior becomes the unconditional
  default and the flag is removed.

There are deliberately no opt-_out_ flags: once a behavior is the default in
a major version, the escape hatch is gone, which keeps the code paths from
accumulating.

## Current flags

| Flag                              | Behavior when enabled                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `failOnConstructsOutsideOfStacks` | Synthesis throws if a construct is scoped directly to the `App` instead of a `TerraformStack`.                          |
| `validateFunctionVersions`        | Each stack statically validates that `Fn` functions are supported by the runtime versions declared in `targetVersions`. |
| `canonicalAssetHashes`            | `TerraformAsset` / `TerraformModuleAsset` hashes use the canonical entry-framed representation described below.         |

## `canonicalAssetHashes`

Introduced in [#323](https://github.com/open-constructs/cdk-terrain/pull/323)
(design: [#322](https://github.com/open-constructs/cdk-terrain/issues/322)).

### Why the legacy hash is not enough

`TerraformAsset.assetHash` decides the asset's output path, so it must change
exactly when the emitted artifact changes. The legacy scheme concatenates
file contents into one digest, which makes it blind to several
artifact-affecting properties:

- **Renames** — `a.txt` → `b.txt` with identical content hashes identically,
  but the emitted archive/directory differs.
- **Entry boundaries** — files `("x", "yz")` and `("xy", "z")` hash
  identically.
- **Permissions** — `chmod 0644` → `0755` changes the zip's external
  attributes (and whether your Lambda binary is executable) but not the
  legacy hash.
- **Empty directories** — added or removed, they are materialized by
  directory assets yet invisible to the legacy hash.

Symlink metadata was folded into the legacy scheme in
[#321](https://github.com/open-constructs/cdk-terrain/pull/321) under a
tagged domain (fixing
[#320](https://github.com/open-constructs/cdk-terrain/issues/320) without
changing hashes for symlink-free trees), but the blind spots above are
structural: they cannot be fixed without changing every asset hash, which is
why the complete scheme is behind a feature flag.

### The canonical representation

The canonical scheme is modeled on git tree objects and Nix NAR
serialization. Review of the first draft
([#322](https://github.com/open-constructs/cdk-terrain/issues/322)) made an
important observation: those formats are canonical **because they serialize a
complete metadata model, not payload framing alone** — git tree entries carry
a mode (`100644` / `100755` / `120000`) and represent directories as objects;
NAR records node types and an executable marker. Borrowing only the
`(type, path, payload)` framing re-introduces exactly the permission and
empty-directory blind spots listed above.

The adopted representation therefore frames, per entry, everything that
affects the emitted artifact:

| entry                   | record                                                     |
| ----------------------- | ---------------------------------------------------------- |
| file                    | `F <mode> <relPath>\0<size>\0` + content                   |
| symlink                 | `L <mode> <relPath>\0<target byte length>\0` + link target |
| directory (incl. empty) | `D <relPath>\0`                                            |

where:

- `<mode>` is the octal permission mask (`0o7777` bits) — precisely the bits
  `archiveSync` preserves in zip external attributes. Directory records carry
  no mode because neither `archiveSync` nor `copySync` preserves directory
  permissions; the hash only covers what is emitted.
- Records appear in sorted directory order with `/`-separated relative
  paths, independent of platform directory-listing order.
- Symlinks contribute their metadata, never their target's content, so
  circular symlinks cannot recurse and shared targets are not
  double-counted. A symlink at the asset root itself is followed, matching
  how the source path is opened when the artifact is emitted.

### Migration impact

Enabling the flag changes **every** asset hash once, which changes every
asset output path (`assets/<name>/<hash>/…`) and re-uploads/re-deploys the
referencing resources (e.g. Lambda functions) on the next apply. Content is
unchanged; this is a one-time path migration. `TerraformModuleAsset` users
can pin hashes across the transition with the existing
`cdktfStaticModuleAssetHash` context key if needed.

### Why adopting it early is recommended

The canonical scheme becomes the unconditional default at the next major
release, and the legacy scheme is removed then. Opting in early means:

- the one-time re-deploy happens on your schedule, not the major upgrade's;
- asset hashes become trustworthy change detectors — anything that alters
  the emitted artifact (content, names, modes, tree shape, symlinks) alters
  the hash, and nothing else does;
- combined with the pinned entry timestamps from
  [#321](https://github.com/open-constructs/cdk-terrain/pull/321), archives
  are byte-reproducible, so downstream hashing such as `filebase64sha256`
  stops drifting.
