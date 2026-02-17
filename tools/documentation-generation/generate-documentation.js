#!/usr/bin/env node
/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import * as fs from "fs";
import * as path from "path";

import { Documentation, Language } from "jsii-docgen";

(async function () {
  const remarkParse = (await import("remark-parse")).default;
  const remarkStringify = (await import("remark-stringify")).default;
  const visit = (await import("unist-util-visit")).visit;
  const unified = (await import("unified")).unified;

  const rootFolder = process.argv[2];
  if (!rootFolder) {
    throw new Error(
      "Please provide the root repository folder as the first argument"
    );
  }

  const sourceFolder = path.resolve(rootFolder, "packages", "cdktn");
  if (!fs.existsSync(sourceFolder)) {
    throw new Error(
      "Expected " +
        sourceFolder +
        " to be the source directory of the cdktn package, but it does not exist"
    );
  }

  const targetFolder = path.resolve(
    rootFolder,
    "website",
    "docs",
    "cdktn",
    "api-reference"
  );
  if (!fs.existsSync(targetFolder)) {
    throw new Error(
      "Expected " +
        targetFolder +
        " to be the directory containing the api reference, but it does not exist"
    );
  }

  const docsJsonPath = path.resolve(
    rootFolder,
    "website",
    "docs",
    "cdktn",
    "docs.json"
  );
  const langDisplayNames = {
    Typescript: "TypeScript",
    Python: "Python",
    Java: "Java",
    CSharp: "C#",
    Go: "Go",
  };

  /**
   * Split an MDAST tree into sections by heading depth.
   * Returns a Map from heading text to a subtree (root node containing
   * all nodes under that heading, up to the next heading of same/higher depth).
   */
  function splitByHeading(tree, depth) {
    const sections = new Map();
    let currentHeading = null;
    let currentNodes = [];

    for (const node of tree.children) {
      if (node.type === "heading" && node.depth <= depth) {
        // Save previous section
        if (currentHeading !== null) {
          sections.set(currentHeading, {
            type: "root",
            children: currentNodes,
          });
        }
        // Extract heading text from the first text child
        // Trim because headings like `## Constructs <a ...>` parse with trailing space
        const textChild = node.children.find((c) => c.type === "text");
        currentHeading = textChild ? textChild.value.trim() : "";
        currentNodes = [];
      } else if (currentHeading !== null) {
        currentNodes.push(node);
      }
    }
    // Save last section
    if (currentHeading !== null) {
      sections.set(currentHeading, {
        type: "root",
        children: currentNodes,
      });
    }
    return sections;
  }

  /**
   * Convert a PascalCase class name to kebab-case for use as a filename.
   * Handles digit-to-uppercase transitions and consecutive uppercase runs.
   */
  function toKebabCase(name) {
    return name
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
      .toLowerCase();
  }

  /**
   * Shift all heading depths in an MDAST tree by a given offset.
   * A negative offset promotes headings (e.g., H4 → H3 with offset -1).
   * Clamps to minimum depth of 1.
   */
  function adjustHeadingDepth(tree, offset) {
    visit(tree, "heading", (node) => {
      node.depth = Math.max(1, node.depth + offset);
    });
  }

  /**
   * Remark plugin that sanitizes prose for MDX compatibility while
   * skipping code and inlineCode nodes entirely. This is the key fix:
   * code blocks are never touched, so `import { Foo }` and `-> str`
   * are preserved exactly as jsii-docgen produced them.
   */
  function sanitizeAst() {
    const PRESERVED_HTML_TAGS = ["code", "a", "sup"];

    return function (tree) {
      visit(tree, function (node, index, parent) {
        // Skip code and inlineCode nodes entirely
        if (node.type === "code" || node.type === "inlineCode") {
          return visit.SKIP;
        }

        if (node.type === "text" && parent) {
          // Handle {@link URL text} patterns — replace with text + link + text splicing
          const linkPattern =
            /\{@link\s+((?:https?:\/\/|\/)[^\s}]+)(?:\s+([^}]+))?\}/;
          let match;
          if ((match = linkPattern.exec(node.value))) {
            const before = node.value.slice(0, match.index);
            const after = node.value.slice(match.index + match[0].length);
            const url = match[1];
            const linkText = match[2] ? match[2].trim() : url;

            const newNodes = [];
            if (before) newNodes.push({ type: "text", value: before });
            newNodes.push({
              type: "link",
              url: url,
              children: [{ type: "text", value: linkText }],
            });
            if (after) newNodes.push({ type: "text", value: after });

            parent.children.splice(index, 1, ...newNodes);
            // Return the index to re-process the "after" text node for more links
            return index;
          }

          // Space out angle brackets for generics like <Foo> in prose
          node.value = node.value.replace(/<([^>]+)>/g, (full, inner) => {
            if (
              PRESERVED_HTML_TAGS.some(
                (tag) => inner === tag || inner === `/${tag}`
              )
            ) {
              return full;
            }
            return `< ${inner} >`;
          });
        }

        if (node.type === "html") {
          // Space out angle brackets in HTML nodes, preserving only known safe tags
          node.value = node.value.replace(/<([^>]+)>/g, (full, inner) => {
            const trimmed = inner.trim();
            if (
              PRESERVED_HTML_TAGS.some(
                (tag) =>
                  trimmed === tag ||
                  trimmed === `/${tag}` ||
                  trimmed.startsWith(`${tag} `) ||
                  trimmed.startsWith(`${tag}\t`)
              )
            ) {
              return full;
            }
            return `< ${inner} >`;
          });
        }

        if (node.type === "link") {
          // Make relative terraform doc links absolute
          if (
            node.url &&
            node.url.startsWith("/terraform/docs/")
          ) {
            node.url = `https://developer.hashicorp.com${node.url}`;
          }
        }
      });
    };
  }

  /**
   * Serialize an MDAST subtree back to markdown using remark-stringify.
   */
  function stringifyTree(subtree) {
    return unified()
      .use(remarkStringify, { bullet: "-", emphasis: "*", strong: "*" })
      .stringify(subtree);
  }

  /**
   * Post-stringify MDX fixups that can't be done at the AST level
   * (either because remark-stringify interferes, or because remark-parse
   * splits inline HTML across multiple MDAST nodes).
   *
   * Applied only to prose — code fences are extracted first and restored after.
   */
  function postProcessForMdx(markdown) {
    const codeBlockRegex = /^```[^\n]*\n[\s\S]*?^```$/gm;
    const codeBlocks = [];
    const placeholder = "\0CODEBLOCK\0";

    const withPlaceholders = markdown.replace(codeBlockRegex, (match) => {
      codeBlocks.push(match);
      return placeholder;
    });

    let result = withPlaceholders
      // Convert autolinks to standard markdown links (MDX treats <url> as JSX)
      .replace(/<(https?:\/\/[^>]+)>/g, (_, url) => `[${url}](${url})`)
      // Escape | inside <code>...</code> spans to prevent MDX table cell splitting.
      // remark-parse splits inline HTML into separate nodes, so this can't be
      // done at the AST level — we need the full string to see across node boundaries.
      .replace(
        /<code>([\s\S]*?)<\/code>/g,
        (full, content) =>
          `<code>${content.replace(/\|/g, "&#124;")}</code>`
      )
      // Escape lone < that don't start HTML tags (e.g., <=, <<a, trailing <).
      // Preserves <tag>, </tag>, and <!-- by requiring a letter, /, or ! after <.
      .replace(/<(?![a-zA-Z/!])/g, "&lt;")
      // Escape { for MDX
      .replace(/\{/g, "\\{");

    let i = 0;
    result = result.replace(
      new RegExp(placeholder.replace(/\0/g, "\\0"), "g"),
      () => codeBlocks[i++]
    );

    return result;
  }

  function compose(lang, topic, content, className = null) {
    const title = className ? `${lang}: ${className}` : `${lang}: ${topic}`;
    const sidebarTitle = className || topic;
    const description = className
      ? `CDKTN Core API Reference for ${className} in ${lang}.`
      : `CDKTN Core API Reference for ${topic} in ${lang}.`;

    return `---
title: "${title}"
sidebarTitle: ${sidebarTitle}
description: ${description}
---

{/* This file is generated through yarn generate-docs */}

${content}
`;
  }

  const assembliesDir = path.resolve(
    rootFolder,
    "tools",
    "documentation-generation",
    "node_modules"
  );

  Documentation.forProject(path.resolve(sourceFolder), {
    assembliesDir,
  }).then(async (docs) => {
    const languages = {
      Typescript: Language.TYPESCRIPT,
      Python: Language.PYTHON,
      Java: Language.JAVA,
      CSharp: Language.CSHARP,
      Go: Language.GO,
    };

    // Collect navigation data for docs.json update
    const navigationData = {};
    const topics = ["Constructs", "Structs", "Classes", "Protocols", "Enums"];

    for (const entry of Object.entries(languages)) {
      const [lang, key] = entry;
      const markdown = await docs.toMarkdown({
        language: key,
        readme: false,
        allSubmodules: true,
      });
      const rendered = markdown.render();

      // Parse the full markdown into an MDAST tree
      const tree = unified().use(remarkParse).parse(rendered);

      // Split into sections by H2 heading (topic level)
      const sections = splitByHeading(tree, 2);

      const langFolder = path.resolve(targetFolder, lang.toLowerCase());
      fs.mkdirSync(langFolder, { recursive: true });

      // Clean up old single-file topics
      for (const topic of topics) {
        const oldFile = path.resolve(langFolder, `${topic.toLowerCase()}.mdx`);
        if (fs.existsSync(oldFile)) {
          fs.unlinkSync(oldFile);
        }
      }

      navigationData[lang] = [];

      for (const topic of topics) {
        const topicSubtree = sections.get(topic);
        if (!topicSubtree || topicSubtree.children.length === 0) {
          continue;
        }

        // Second-level split: by H3 (individual class/construct names)
        const classSections = splitByHeading(topicSubtree, 3);

        if (classSections.size === 0) {
          continue;
        }

        // Create topic subdirectory
        const topicFolder = path.resolve(langFolder, topic.toLowerCase());
        fs.mkdirSync(topicFolder, { recursive: true });

        const topicPages = [];

        for (const [className, classSubtree] of classSections) {
          // Shift headings: H4→H2, H5→H3, H6→H4
          // Mintlify TOC shows H2/H3, so sections (Initializers, Methods)
          // should be H2 and members (toString, node) should be H3.
          adjustHeadingDepth(classSubtree, -2);

          // Sanitize, stringify, post-process (same pipeline as before)
          sanitizeAst()(classSubtree);
          const content = postProcessForMdx(stringifyTree(classSubtree));

          const fileName = toKebabCase(className);
          const filePath = path.resolve(topicFolder, `${fileName}.mdx`);

          fs.writeFileSync(
            filePath,
            compose(lang, topic, content, className),
            "utf-8"
          );

          // Collect page path for docs.json (without .mdx extension)
          topicPages.push(
            `api-reference/${lang.toLowerCase()}/${topic.toLowerCase()}/${fileName}`
          );
        }

        navigationData[lang].push({
          group: topic,
          expanded: false,
          pages: topicPages,
        });
      }
    }

    // Update docs.json with generated navigation
    if (fs.existsSync(docsJsonPath)) {
      const docsJson = JSON.parse(fs.readFileSync(docsJsonPath, "utf-8"));

      // Find the API Reference tab
      const apiRefTab = docsJson.navigation.tabs.find(
        (t) => t.tab === "API Reference"
      );

      if (apiRefTab) {
        // Keep Overview group, replace language groups
        const overviewGroup = apiRefTab.groups.find(
          (g) => g.group === "Overview"
        );
        const newGroups = overviewGroup ? [overviewGroup] : [];

        for (const [lang] of Object.entries(languages)) {
          const displayName = langDisplayNames[lang] || lang;
          const topicGroups = navigationData[lang];

          if (topicGroups && topicGroups.length > 0) {
            newGroups.push({
              group: displayName,
              pages: topicGroups,
            });
          }
        }

        apiRefTab.groups = newGroups;
      }

      fs.writeFileSync(
        docsJsonPath,
        JSON.stringify(docsJson, null, 2) + "\n",
        "utf-8"
      );
      const totalPages = Object.values(navigationData)
        .flat()
        .reduce((sum, g) => sum + g.pages.length, 0);
      console.log(
        `Updated ${docsJsonPath} with ${totalPages} page references`
      );
    } else {
      console.warn(
        `Warning: docs.json not found at ${docsJsonPath}, skipping navigation update`
      );
    }
  });
})();
