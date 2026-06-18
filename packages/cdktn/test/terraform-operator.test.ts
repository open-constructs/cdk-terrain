// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from "constructs";
import { TerraformStack } from "../src";
import { Op } from "../src/terraform-operators";
import { Expression } from "../src/tfExpression";
import { resolve } from "../src/_tokens";

const appScope = new Construct(undefined as any, "randomScope");

const stack = new TerraformStack(appScope, "Stack");
const resolveExpression = (expr: Expression) => resolve(stack, expr);

test("Op.not renders correctly", () => {
  expect(resolveExpression(Op.not(true))).toMatchInlineSnapshot(`"\${!true}"`);
});
test("Op.negate renders correctly", () => {
  expect(resolveExpression(Op.negate(1))).toMatchInlineSnapshot(`"\${-1}"`);
});
test("Op.mul renders correctly", () => {
  expect(resolveExpression(Op.mul(2, 3))).toMatchInlineSnapshot(
    `"\${(2 * 3)}"`,
  );
});
test("Op.div renders correctly", () => {
  expect(resolveExpression(Op.div(4, 2))).toMatchInlineSnapshot(
    `"\${(4 / 2)}"`,
  );
});
test("Op.mod renders correctly", () => {
  expect(resolveExpression(Op.mod(5, 3))).toMatchInlineSnapshot(
    `"\${(5 % 3)}"`,
  );
});
test("Op.add renders correctly", () => {
  expect(resolveExpression(Op.add(1, 1))).toMatchInlineSnapshot(
    `"\${(1 + 1)}"`,
  );
});
test("Op.sub renders correctly", () => {
  expect(resolveExpression(Op.sub(1, 2))).toMatchInlineSnapshot(
    `"\${(1 - 2)}"`,
  );
});
test("Op.gt renders correctly", () => {
  expect(resolveExpression(Op.gt(1, 2))).toMatchInlineSnapshot(`"\${(1 > 2)}"`);
});
test("Op.gte renders correctly", () => {
  expect(resolveExpression(Op.gte(1, 2))).toMatchInlineSnapshot(
    `"\${(1 >= 2)}"`,
  );
});
test("Op.lt renders correctly", () => {
  expect(resolveExpression(Op.lt(1, 2))).toMatchInlineSnapshot(`"\${(1 < 2)}"`);
});
test("Op.lte renders correctly", () => {
  expect(resolveExpression(Op.lte(1, 2))).toMatchInlineSnapshot(
    `"\${(1 <= 2)}"`,
  );
});
test("Op.eq renders correctly", () => {
  expect(resolveExpression(Op.eq(1, 1))).toMatchInlineSnapshot(
    `"\${(1 == 1)}"`,
  );
});
test("Op.neq renders correctly", () => {
  expect(resolveExpression(Op.neq(1, 2))).toMatchInlineSnapshot(
    `"\${(1 != 2)}"`,
  );
});
test("Op.and renders correctly", () => {
  expect(resolveExpression(Op.and(true, true))).toMatchInlineSnapshot(
    `"\${(true && true)}"`,
  );
});
test("Op.or renders correctly", () => {
  expect(resolveExpression(Op.or(true, true))).toMatchInlineSnapshot(
    `"\${(true || true)}"`,
  );
});

// Regression tests for falsy right-hand operands
test("Op.gt renders correctly with 0 as right operand", () => {
  expect(resolveExpression(Op.gt(1, 0))).toMatchInlineSnapshot(`"\${(1 > 0)}"`);
});
test("Op.eq renders correctly with false as right operand", () => {
  expect(resolveExpression(Op.eq(true, false))).toMatchInlineSnapshot(
    `"\${(true == false)}"`,
  );
});
test("Op.sub renders correctly with 0 as right operand", () => {
  expect(resolveExpression(Op.sub(5, 0))).toMatchInlineSnapshot(
    `"\${(5 - 0)}"`,
  );
});
