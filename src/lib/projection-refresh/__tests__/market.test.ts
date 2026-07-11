import test from "node:test";
import assert from "node:assert/strict";
import { americanImplied, noVigTwoSided } from "../market.server.ts";

test("americanImplied: positive odds", () => {
  const p = americanImplied(150);
  assert.ok(p !== null && Math.abs(p - 0.4) < 1e-9);
});

test("americanImplied: negative odds", () => {
  const p = americanImplied(-200);
  assert.ok(p !== null && Math.abs(p - 2 / 3) < 1e-9);
});

test("americanImplied: nulls", () => {
  assert.equal(americanImplied(null), null);
  assert.equal(americanImplied(0), null);
});

test("noVigTwoSided: strips vig on symmetric market", () => {
  const over = americanImplied(-110);
  const under = americanImplied(-110);
  const nv = noVigTwoSided(over, under);
  assert.ok(nv !== null && Math.abs(nv - 0.5) < 1e-9);
});

test("noVigTwoSided: falls back to raw implied when only one side is priced", () => {
  const p = americanImplied(120);
  const nv = noVigTwoSided(p, null);
  assert.equal(nv, p);
});
