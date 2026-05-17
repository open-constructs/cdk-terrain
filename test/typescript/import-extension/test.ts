// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { TestDriver } from "../../test-helper";

describe("languageOptions.importExtension", () => {
  let driver: TestDriver;

  beforeAll(async () => {
    driver = new TestDriver(__dirname);
    await driver.setupTypescriptProject();
  });

  test(".js importExtension", () => {
    // The provider-level index re-exports child modules. With .js configured,
    // every relative import should carry the suffix.
    const providerIndex = driver.readLocalFile(".gen/providers/null/index.ts");
    expect(providerIndex).toMatch(/from '\.\/[^']+\.js'/);
    expect(providerIndex).not.toMatch(/from '\.\/[^']+\/index';/);
  });

  test("lazy-index remains CommonJS regardless of importExtension", () => {
    // lazy-index uses runtime require() and must not adopt the ESM suffix —
    // it's loaded by the cdktn runtime, not by a TS/ESM resolver.
    const lazyIndex = driver.readLocalFile(".gen/providers/null/lazy-index.ts");
    expect(lazyIndex).toMatch(/require\('\.\/[^']+'\)/);
    expect(lazyIndex).not.toMatch(/require\('\.\/[^']+\.js'\)/);
  });
});
