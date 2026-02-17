# Documentation Generation

Generates API reference docs from the `cdktn` JSII assembly using [`jsii-docgen`](https://github.com/cdklabs/jsii-docgen), outputting Mintlify-compatible MDX files.

## Usage

```bash
# From repo root (builds all packages first):
yarn generate-docs:api

# Or from this directory (assumes packages are already built):
yarn && yarn docs
```

Output: `website/docs/cdktn/api-reference/<language>/<topic>.mdx` (25 files total).

To publish, copy the output into the Mintlify docs site:

```bash
cp -r website/docs/cdktn/api-reference/* ../docs/content/api-reference/
```

## How It Works

### Pipeline

All transforms operate on the MDAST (abstract syntax tree) via remark/unified, so `code` and `inlineCode` nodes are naturally skipped — no placeholder hacks needed.

```
packages/cdktn/.jsii  (JSII assembly)
        │
        ▼
   jsii-docgen           Generates one large markdown doc per language
        │
        ▼
   remark-parse           Parse into MDAST (full AST)
        │
        ▼
   splitByHeading(tree, 2)   Split by H2 into Map<topic, MDAST subtree>
        │
        ▼
   sanitizeAst(subtree)      Walk text/html/link nodes, skip code/inlineCode
        │
        ▼
   remark-stringify           Serialize back to clean markdown
        │
        ▼
   postProcessForMdx()        MDX fixups: autolinks, `|` in <code>, lone `<`, `{`
        │
        ▼
   compose()                  Wrap with MDX frontmatter, write .mdx files
```

### Languages and Topics

5 languages x 5 topics = 25 `.mdx` files:

| Languages  | Topics     |
| ---------- | ---------- |
| Typescript | Constructs |
| Python     | Structs    |
| Java       | Classes    |
| CSharp     | Protocols  |
| Go         | Enums      |

### Output Format

Each file gets Mintlify frontmatter:

```yaml
---
title: "Typescript: Constructs"
sidebarTitle: Constructs
description: CDKTN Core API Reference for Constructs in Typescript.
---
```

- `title` — page heading (e.g., "Typescript: Constructs")
- `sidebarTitle` — short label for the nav sidebar (e.g., "Constructs"), since the language is already provided by the sidebar group
- The original H2 topic heading from jsii-docgen is stripped to avoid duplication with the frontmatter title

### MDX Sanitization (`sanitizeAst`)

All sanitization is done at the AST level via a single `visit()` pass. The key advantage: `code` and `inlineCode` nodes are **skipped entirely**, so content like `import { Foo }` in TypeScript blocks and `-> str` in Python blocks is never corrupted.

**`text` nodes** (prose):

- `{@link URL text}` → spliced into proper MDAST link nodes
- `<Foo>` generics → `< Foo >` (prevents MDX/HTML parsing; preserves `<code>`, `<a>`, `<sup>`)

**`html` nodes**:

- Angle bracket spacing, preserving real HTML tags (detected by tag name pattern)

**`link` nodes**:

- Relative terraform doc links (`/terraform/docs/...`) → absolute URLs (prefixes `https://developer.hashicorp.com`). Temporary workaround; see [#33](https://github.com/open-constructs/cdk-terrain/issues/33).

**`code` / `inlineCode` nodes**: skipped — `remark-stringify` outputs their values raw

**`postProcessForMdx`** (post-stringify string-level fixups, code-fence-aware):

- `<url>` autolinks → `[url](url)` (MDX treats `<...>` as JSX)
- `|` inside `<code>...</code>` → `&#124;` (prevents MDX table cell splitting)
- Lone `<` not starting HTML tags (e.g., `<=`, `<<a`) → `&lt;`
- `{` → `\{` (MDX brace escaping; can't be done at AST level because `remark-stringify` would double-escape)

## Package Notes

This package is excluded from workspace hoisting because it needs a locally installed copy of `cdktn` and `constructs` in its own `node_modules/` for jsii-docgen to resolve the JSII assembly.
