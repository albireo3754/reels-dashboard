import { strict as assert } from "node:assert";
import { test } from "node:test";
import ts from "typescript";
import { annotateJsxSource } from "../../scripts/jsx-source";
import {
  compactSources,
  feedbackPrompt,
} from "../../src/features/ui-inspector/model/inspect";

test("JSX provenance preserves expressions and only annotates intrinsic repository elements", () => {
  const source =
    'const C = () => <Panel><button title="한글">Hi</button>\n<input data-reels-source="existing" /><svg><path d="M0 0" /></svg></Panel>;';
  const annotated = annotateJsxSource(source, "src/renderer/Example.tsx");
  assert.match(annotated, /<Panel>/);
  assert.match(
    annotated,
    /<button data-reels-source=\{"src\/renderer\/Example.tsx:1:24"\}/,
  );
  assert.match(annotated, /<input data-reels-source="existing" \/>/);
  assert.equal((annotated.match(/data-reels-source/g) ?? []).length, 4);
  assert.equal(annotateJsxSource(source, "/outside/Example.tsx"), source);
  assert.equal(annotateJsxSource(source, "src/../outside.tsx"), source);
  const result = ts.transpileModule(annotated, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX },
    reportDiagnostics: true,
  });
  assert.equal(result.diagnostics?.length, 0);
});

test("source ancestry keeps innermost contiguous file and meaningful component boundary", () => {
  assert.deepEqual(
    compactSources([
      "src/features/card/A.tsx:12:3",
      "src/features/card/A.tsx:10:1",
      "src/shared/Button.tsx:5:2",
      "src/shared/Button.tsx:2:1",
      "src/features/card/A.tsx:2:1",
      "/private/source.tsx:1:1",
      "src/../secret.tsx:1:1",
    ]),
    [
      "src/features/card/A.tsx:12:3",
      "src/shared/Button.tsx:5:2",
      "src/features/card/A.tsx:2:1",
    ],
  );
  const prompt = feedbackPrompt(
    { tag: "button", sources: ["src/renderer/App.tsx:15:2"] },
    "  크기를 줄여주세요.  ",
  );
  assert.match(prompt, /크기를 줄여주세요\./);
  assert.match(prompt, /src\/renderer\/App.tsx:15:2/);
});
