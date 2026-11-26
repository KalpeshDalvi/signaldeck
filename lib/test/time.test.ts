import assert from "node:assert/strict";
import test from "node:test";
import { formatCentralDateTime, formatCentralTime } from "../time";

test("evidence timestamps use the Central calendar date and seasonal offset", () => {
  assert.match(formatCentralDateTime("2026-11-26T02:47:23Z"), /^Nov 25, 2026,\s+8:47:23\s+PM CST$/);
  assert.match(formatCentralDateTime("2026-07-26T02:47:23Z"), /^Jul 25, 2026,\s+9:47:23\s+PM CDT$/);
});

test("the two occurrences of the fall-back hour retain distinct timezone labels", () => {
  assert.match(formatCentralTime("2026-11-01T06:30:00Z"), /^1:30:00\s+AM CDT$/);
  assert.match(formatCentralTime("2026-11-01T07:30:00Z"), /^1:30:00\s+AM CST$/);
});
