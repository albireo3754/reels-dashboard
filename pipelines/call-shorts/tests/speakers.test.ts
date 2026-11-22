import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { main } from "../src/cli.js";
import { UsageError } from "../src/errors.js";
import { mapSpeakers, saveTranscript, speakersPath } from "../src/transcribe.js";
import { fixtureTranscript, makeConfig, makeProject } from "./helpers.js";

function projectWithTranscript() {
  const config = makeConfig();
  const project = makeProject(config.rootDir);
  saveTranscript(project, fixtureTranscript());
  return { config, project };
}

test("map-speakers rejects a duplicate role before writing", () => {
  const { project } = projectWithTranscript();
  assert.throws(
    () => mapSpeakers(project, "GF", "GF"),
    (error: Error) => error instanceof UsageError && /같습니다/.test(error.message),
  );
  assert.ok(!existsSync(speakersPath(project)));
  assert.ok(!existsSync(path.join(project, "transcript", "transcript.md")), "전사문도 저장하지 않습니다");
});

test("map-speakers rejects anything other than GF/BF", () => {
  const { project } = projectWithTranscript();
  for (const [a, b] of [["남자", "여자"], ["GF", "여자"], ["", "BF"]]) {
    assert.throws(
      () => mapSpeakers(project, a, b),
      (error: Error) => error instanceof UsageError && /GF\(여자\) 또는 BF\(남자\)/.test(error.message),
      `${a}/${b}`,
    );
  }
  assert.ok(!existsSync(speakersPath(project)));
});

test("map-speakers normalizes case and stores the chosen roles", () => {
  const { project } = projectWithTranscript();
  const transcript = mapSpeakers(project, "bf", "gf");
  assert.deepEqual(transcript.speakerMap, { SPEAKER_00: "BF", SPEAKER_01: "GF" });
  assert.deepEqual(JSON.parse(readFileSync(speakersPath(project), "utf8")).map, { SPEAKER_00: "BF", SPEAKER_01: "GF" });
  assert.match(readFileSync(path.join(project, "transcript", "transcript.md"), "utf8"), /남자: 여보세요/);
});

test("the CLI exits 2 on a bad --a/--b value and stores nothing", async () => {
  const { config, project } = projectWithTranscript();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    assert.equal(await main(["map-speakers", "--root", config.rootDir, "--project", project, "--a", "남자", "--b", "여자"]), 2);
  } finally {
    console.error = original;
  }
  assert.match(errors.join("\n"), /GF\(여자\) 또는 BF\(남자\)/);
  assert.ok(!existsSync(speakersPath(project)));
});
