// scripts/check-anthropic-params.mjs
//
// [A2] The 5.x Claude models (and Opus 4.7 / 4.8) reject `temperature` with a
// 400. callClaude fails open, so a stray temperature does not crash anything:
// it silently turns the feature off. That is how voice checks and the output
// rubric went dark in production. This check asserts on the request body
// callClaude would send, with no network call:
//
//   1. no temperature reaches a model that rejects it, whatever the caller passes
//   2. older models that accept it still get it (no behavior change there)
//   3. effort lands in output_config, never top level
//   4. no file under api/ passes `temperature` to callClaude at all

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildRequestBody, modelRejectsTemperature, DEFAULT_MODEL } from "../api/_lib/anthropic.js";
import { STRATEGY_MODEL_FAST, STRATEGY_MODEL_STRONG } from "../api/strategy.js";
import { MODEL_SONNET } from "../api/_lib/prompts.js";
import { REVIEW_MODEL } from "../api/_lib/review.js";

let failures = 0;
function assert(cond, msg) { if (!cond) { failures++; console.error("FAIL " + msg); } }

const REJECTS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5-5", "claude-opus-5",
  "claude-fable-5-2", "claude-mythos-5-2", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-6"];
const ACCEPTS = ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001"];

for (const model of REJECTS) {
  assert(modelRejectsTemperature(model), `${model} should be flagged as rejecting temperature`);
  const body = buildRequestBody({ model, prompt: "hi", temperature: 0.4, effort: "low" });
  assert(!("temperature" in body), `${model}: request body must not contain temperature`);
  assert(body.output_config && body.output_config.effort === "low", `${model}: effort should be in output_config`);
  assert(!("effort" in body), `${model}: effort must not be top level`);
}
for (const model of ACCEPTS) {
  assert(!modelRejectsTemperature(model), `${model} should still accept temperature`);
  const body = buildRequestBody({ model, prompt: "hi", temperature: 0 });
  assert(body.temperature === 0, `${model}: temperature 0 should still be sent`);
}

// The models the app actually calls today, by constant, so a future bump is
// covered without editing this file.
for (const model of [STRATEGY_MODEL_FAST, STRATEGY_MODEL_STRONG, MODEL_SONNET, REVIEW_MODEL, DEFAULT_MODEL]) {
  const body = buildRequestBody({ model, prompt: "hi", temperature: 0.7 });
  if (modelRejectsTemperature(model)) assert(!("temperature" in body), `${model} (in use): temperature leaked into the body`);
}

// No call site passes temperature at all. The helper strips it, but a caller
// that passes one is a caller that believes it matters.
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}
for (const file of walk("api", [])) {
  if (file.endsWith("_lib/anthropic.js")) continue;
  const src = readFileSync(file, "utf8").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  assert(!/\btemperature\s*:/.test(src), `${file}: passes a temperature parameter`);
}

if (failures) { console.error(`\n${failures} Anthropic parameter check(s) failed.`); process.exit(1); }
console.log("OK: no temperature reaches a model that rejects it; effort rides in output_config.");
