// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { checkIdentifier, Requirement } from "./key-provider";

/**
 * An encryption method for {@link OpenTofuEncryption}. The methods that the encryption's targets use are written to
 * the `encryption` block, so they don't need to be added anywhere. Each method OpenTofu ships has its own class, such
 * as {@link OpenTofuAesGcmMethod}.
 */
export class OpenTofuEncryptionMethod {
  /**
   * A method of any type, with its attributes written as given. Nested objects are written as object attributes, not
   * blocks, and key providers as references to them.
   * @param type - the method type
   * @param name - a name for the method, unique among methods of the same type
   * @param config - the method's attributes, named as in the OpenTofu documentation, e.g. `keys`
   * @returns the method
   */
  public static custom(
    type: string,
    name: string,
    config: { [key: string]: any } = {},
  ): OpenTofuEncryptionMethod {
    return new OpenTofuEncryptionMethod(type, name, config);
  }

  /**
   * A method that is declared outside the stack, e.g. in the `TF_ENCRYPTION` environment variable, so it is
   * referenced but not written.
   * @param type - the method type
   * @param name - the method's name
   * @returns the method
   */
  public static fromEnvironment(
    type: string,
    name: string,
  ): OpenTofuEncryptionMethod {
    return new OpenTofuEncryptionMethod(type, name);
  }

  /**
   * The method type, e.g. `aes_gcm`.
   */
  public readonly type: string;

  /**
   * The method's name.
   */
  public readonly name: string;

  /**
   * The attributes, or undefined if the method is declared outside the stack.
   * @internal
   */
  public readonly _config?: { [key: string]: any };

  /**
   * @internal
   */
  public readonly _requires: Requirement[] = [];

  /**
   * @param type - the method type
   * @param name - a name for the method, unique among methods of the same type
   * @param config - the method's attributes, named as OpenTofu names them; undefined for a method that is declared
   * outside the stack
   */
  protected constructor(
    type: string,
    name: string,
    config?: { [key: string]: any },
  ) {
    checkIdentifier(type);
    checkIdentifier(name);
    this.type = type;
    this.name = name;
    this._config = config;
  }
}
