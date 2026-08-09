import assert from "node:assert/strict";
import test from "node:test";

import { buildSchedule } from "../src/discussion/engine.js";
import { ROLE, assignRoles } from "../src/discussion/roles.js";
import { toGeminiSchema } from "../src/llm/schema.js";

test("進行表は開会で始まり総括で終わる", () => {
  const schedule = buildSchedule({ maxRounds: 10, mcInterval: 3 });
  assert.equal(schedule[0].phase, "opening");
  assert.equal(schedule[0].role, ROLE.MC);
  assert.equal(schedule.at(-1).phase, "closing");
  assert.equal(schedule.at(-1).role, ROLE.MC);
  assert.equal(schedule.at(-1).round, 11);
});

test("巡ごとに肯定側と否定側の先手が入れ替わる", () => {
  const schedule = buildSchedule({ maxRounds: 4, mcInterval: 0 });
  const round1 = schedule.filter((step) => step.round === 1);
  const round2 = schedule.filter((step) => step.round === 2);
  assert.deepEqual(
    round1.map((step) => step.role),
    [ROLE.POSITIVE, ROLE.NEGATIVE],
  );
  assert.deepEqual(
    round2.map((step) => step.role),
    [ROLE.NEGATIVE, ROLE.POSITIVE],
  );
});

test("議長は指定間隔で中間整理に入り、最終巡には割り込まない", () => {
  const schedule = buildSchedule({ maxRounds: 6, mcInterval: 3 });
  const interjections = schedule.filter((step) => step.phase === "interjection");
  assert.deepEqual(
    interjections.map((step) => step.round),
    [3],
  );
});

test("mcInterval=0なら中間整理は入らない", () => {
  const schedule = buildSchedule({ maxRounds: 5, mcInterval: 0 });
  assert.equal(schedule.filter((step) => step.phase === "interjection").length, 0);
});

test("3社そろえば役割は重複せず割り当てられる", () => {
  const assignments = assignRoles(["claude", "openai", "gemini"], () => 0.5);
  assert.equal(assignments.length, 3);
  assert.equal(new Set(assignments.map((a) => a.providerId)).size, 3);
  assert.equal(new Set(assignments.map((a) => a.role)).size, 3);
});

test("1社しかなくても全役割が埋まる", () => {
  const assignments = assignRoles(["claude"]);
  assert.equal(assignments.length, 3);
  assert.ok(assignments.every((a) => a.providerId === "claude"));
});

test("キーが無ければ討議を開始できない", () => {
  assert.throws(() => assignRoles([]), /APIキー/);
});

test("役割の割り当てはランダムに変わる", () => {
  const seen = new Set();
  for (let i = 0; i < 60; i += 1) {
    const assignments = assignRoles(["claude", "openai", "gemini"]);
    seen.add(assignments.map((a) => `${a.role}:${a.providerId}`).join("|"));
  }
  // 6通りの並びのうち、少なくとも複数が現れること。
  assert.ok(seen.size > 1, "割り当てが固定されている");
});

test("GeminiスキーマはOpenAPIサブセット外のキーを落とす", () => {
  const converted = toGeminiSchema({
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 100, description: "件数" },
      filters: {
        type: "array",
        items: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
      },
    },
    required: ["limit"],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
  });

  assert.equal(converted.type, "OBJECT");
  assert.equal(converted.properties.limit.type, "INTEGER");
  assert.equal(converted.properties.limit.description, "件数");
  assert.ok(!("minimum" in converted.properties.limit));
  assert.ok(!("additionalProperties" in converted));
  assert.ok(!("$schema" in converted));
  assert.equal(converted.properties.filters.items.type, "OBJECT");
  assert.equal(converted.properties.filters.items.properties.key.type, "STRING");
  assert.deepEqual(converted.required, ["limit"]);
});

test("propertiesの無いobjectにも空のpropertiesを補う", () => {
  const converted = toGeminiSchema({ type: "object" });
  assert.deepEqual(converted.properties, {});
});
