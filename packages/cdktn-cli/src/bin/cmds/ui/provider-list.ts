// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { renderProviderTable } from "../helper/format";

/**
 * Print the provider list as a cli-table3 bordered table. Used by `cdktn provider list` after the data has been
 * collected upstream.
 *
 * @param data - Rows of provider info; column headers are derived from the keys of the first row. Empty arrays produce
 *               a "No providers found." message instead of a table.
 */
export function printProviderList(data: any[]): void {
  if (data.length === 0) {
    console.log("No providers found.");
    return;
  }
  console.log(renderProviderTable(data));
}
