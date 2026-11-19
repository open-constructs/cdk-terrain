// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { OpenTofuEncryptionMethod } from "../method";

/**
 * Leaves the data unencrypted, as a `fallback` while migrating existing state, or as `method` while removing
 * encryption.
 */
export class OpenTofuUnencryptedMethod extends OpenTofuEncryptionMethod {
  /**
   * @param name - a name for the method, unique among `unencrypted` methods
   */
  constructor(name: string) {
    super("unencrypted", name, {});
  }
}
