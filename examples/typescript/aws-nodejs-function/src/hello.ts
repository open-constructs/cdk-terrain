// Copyright (c) OpenConstructs
// SPDX-License-Identifier: MPL-2.0
export async function handler(event: { name?: string } = {}) {
  return {
    message: `${process.env.GREETING ?? "Hello"}, ${event.name ?? "world"}!`,
  };
}
