import { test } from "node:test";
import assert from "node:assert/strict";
import { lineEndFragments, rows, type LaidOutChar } from "../../src/shared/blog-line-ends";

// Lay out text as fixed-width rows of `perRow` characters (16px each, 24px rows).
const layout = (text: string, perRow: number): LaidOutChar[] =>
  [...text].map((ch, i) => {
    const row = Math.floor(i / perRow),
      col = i % perRow;
    return { ch, top: row * 24, bottom: row * 24 + 20, left: col * 16 };
  });

test("rows split where a character moves down or back to the left", () => {
  assert.deepEqual(rows(layout("가나다라마바", 4)), ["가나다라", "마바"]);
  assert.deepEqual(rows(layout("가나다", 4)), ["가나다"]);
});

test("only a last row of one or two visible characters is reported", () => {
  const line = (text: string, n: number) => ({ bundle: "b1", paragraph: 1, line: n, chars: layout(text, 10) });
  // Ten characters per row: each line below is written so its last row is known.
  const found = lineEndFragments(
    [
      line("국물이 아주 진하고 좋았어요.", 1), // 16 chars: last row "고 좋았어요." → kept
      line("국물이 진하고 맛있었다.", 2), // 13 chars: last row "었다." (3) → kept
      line("국물이 진하고 맛있다.", 3), // 12 chars: last row "다." → reported
      line("짧은 줄이에요.", 4), // one row → never reported
      line("국물이 진하고 좋다 요", 5), // 12 chars: last row " 요" → reported as "요"
    ],
    360,
  );
  assert.deepEqual(
    found.map((f) => [f.line, f.tail]),
    [
      [3, "다."],
      [5, "요"],
    ],
  );
  assert.equal(found[0].width, 360);
  assert.equal(found[0].text, "국물이 진하고 맛있다.");
  // A wider limit also catches three-character tails.
  assert.equal(lineEndFragments([line("국물이 진하고 맛있었다.", 1)], 390, 3).length, 1);
});
