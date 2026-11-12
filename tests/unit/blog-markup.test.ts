import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPONENTS,
  DEFAULT_PALETTE,
  MarkupParseError,
  SE_FONT_STEPS,
  SIZE_ROLES,
  fromDraft,
  parse,
  parseStyleTokens,
  serialize,
  styleTokens,
  validate,
  collageRows,
  type MarkupDoc,
  type ParagraphNode,
} from "../../src/shared/blog-markup";
import { renderHtml } from "../../src/shared/blog-markup-render";

const sample = `<!-- 범례는 무시된다 -->
<Bundle id="B02" name="대기" core question="들어가기까지 얼마나 기다렸나" in="자리 모양 → 앉기까지">
<Photo file="interior.jpg" alt="손님이 가득한 실내"/>

¶ P3
줄이 길어서
⟦40분 정도⟧¹ 기다렸는데
창가 자리가 나서 ⟦완전 럭키!!⟧²
  ¹ 적갈 굵게 · 대기 시간
  ² 노랑배경 · 착석 결과
  ※ 3번째 줄 16자

<PriceBox>
¶ P4
아메리카노 ⟦5,000원⟧¹
  ¹ 적갈 굵게 · 가격
</PriceBox>
<Heading>디저트</Heading>
</Bundle>
`;

const paragraphsOf = (doc: MarkupDoc): ParagraphNode[] =>
  doc.bundles.flatMap((b) => b.nodes.flatMap((n) => (n.kind === "paragraph" ? [n] : n.children ?? [])));

test("문장은 원문 그대로, 강조는 줄 오프셋과 각주 서식으로 읽힌다", () => {
  const doc = parse(sample);
  const [b] = doc.bundles;
  assert.equal(b.id, "B02");
  assert.equal(b.core, true);
  assert.equal(b.transitionIn, "자리 모양 → 앉기까지");
  const [p3, p4] = paragraphsOf(doc);
  assert.deepEqual(p3.lines, ["줄이 길어서", "40분 정도 기다렸는데", "창가 자리가 나서 완전 럭키!!"]);
  const phrase = (p: ParagraphNode, n: number) => {
    const m = p.marks.find((x) => x.n === n)!;
    return p.lines[m.line].slice(m.start, m.end);
  };
  assert.equal(phrase(p3, 1), "40분 정도");
  assert.equal(phrase(p3, 2), "완전 럭키!!");
  assert.deepEqual(p3.marks.find((m) => m.n === 1)!.style, { color: "#a64132", weight: 700 });
  assert.equal(p3.marks.find((m) => m.n === 2)!.role, "착석 결과");
  assert.deepEqual(p3.notes, ["3번째 줄 16자"]);
  assert.equal(p4.id, "P4");
  const tags = b.nodes.filter((n) => n.kind === "component").map((n) => n.kind === "component" && n.tag);
  assert.deepEqual(tags, ["Photo", "PriceBox", "Heading"]);
});

test("직렬화와 파싱은 왕복해도 같다", () => {
  const doc = parse(sample);
  const text = serialize(doc);
  assert.deepEqual(parse(text), { ...doc, bundles: doc.bundles.map(b => ({ ...b, nodes: b.nodes.map(n => n.kind === "paragraph" ? { ...n, notes: [] } : { ...n, ...(n.children ? {children:n.children.map(p=>({...p,notes:[]}))} : {}) }) })) });
  assert.equal(serialize(parse(text)), text);
  assert.ok(!text.includes("<!--"));
  assert.match(serialize(doc, {legend:true}), /^<!-- blog-markup v1/);
  assert.ok(!serialize(doc, { legend: false }).includes("<!--"));
});

test("두 자리 각주 번호, 따옴표 속성, 이름 없는 색과 크기 역할", () => {
  const doc: MarkupDoc = {
    version: 1,
    bundles: [{
      id: "B1", name: "첫", question: 'q "인용" & 기호', core: false,
      nodes: [{
        kind: "paragraph", id: "P1", lines: ["가나다라마바사"], notes: [],
        marks: [
          { n: 12, line: 0, start: 0, end: 2, style: { color: "#123456", size: 19, sizeRole: "up" }, role: "제목" },
          { n: 3, line: 0, start: 4, end: 7, style: { background: "#abcdef", size: 13 } },
        ],
      }],
    }],
  };
  const text = serialize(doc);
  assert.match(text, /⟦가나⟧¹²다라⟦마바사⟧³/);
  assert.match(text, /¹² 색#123456 up19 · 제목/);
  assert.match(text, /³ 배경#abcdef 크기13/);
  assert.deepEqual(parse(text), { ...doc, bundles: doc.bundles.map(b => ({ ...b, nodes: b.nodes.map(n => n.kind === "paragraph" ? { ...n, notes: [] } : { ...n, ...(n.children ? {children:n.children.map(p=>({...p,notes:[]}))} : {}) }) })) });
});

test("서식 토큰은 팔레트 이름과 크기 단계를 오간다", () => {
  for (const p of DEFAULT_PALETTE) {
    const style = parseStyleTokens([p.name]);
    assert.deepEqual(styleTokens(style), [p.name]);
  }
  assert.deepEqual(parseStyleTokens(["aside13"]), { size: 13, sizeRole: "aside" });
  assert.throws(() => parseStyleTokens(["보라"]), /모르는 서식 토큰/);
  for (const r of Object.values(SIZE_ROLES)) assert.ok((SE_FONT_STEPS as readonly number[]).includes(r.px));
});

test("잘못된 마크업은 행 번호와 함께 거부한다", () => {
  const bad = (src: string, re: RegExp) =>
    assert.throws(() => parse(src), (e: unknown) => e instanceof MarkupParseError && re.test(e.message));
  bad('<Bundle id="a" name="n">\n¶ P1\n⟦가⟧¹\n</Bundle>', /각주 없는 강조/);
  bad('<Bundle id="a" name="n">\n¶ P1\n가\n  ² 굵게\n</Bundle>', /본문에 없는 각주/);
  bad('<Bundle id="a" name="n">\n<Info>\n<Unknown/>\n</Info>\n</Bundle>', /모르는 컴포넌트/);
  bad('<Bundle id="a" name="n">\n¶ P1\n가\n  ※ 메모\n나\n</Bundle>', /각주·메모 뒤에 텍스트/);
  bad('<Bundle id="a" name="n">\n<Heading/>\n</Bundle>', /text 형식/);
  bad("¶ P1\n가", /Bundle 밖/);
  bad('<Bundle id="a" name="n">\n¶ P1\n⟦가⟧\n</Bundle>', /⟦⟧/);
});

test("검사는 폭과 무관한 것만 본다", () => {
  const doc = parse(`<Bundle id="B1" name="첫" question="">
<Photo file="a.jpg"/>

¶ P1
가나다라마바사아자차카타파하가나다라마바사아자차카타
⟦장소 이름⟧¹이 생각났어요
⟦확인일⟧² · ⟦굵기만⟧³
  ¹ 노랑배경 굵게 크기20 · 장소
  ² aside19 · 곁말
  ³ 굵게
</Bundle>`);
  const msgs = validate(doc).map((i) => `${i.level}:${i.message}`);
  assert.ok(msgs.some((m) => m.startsWith("error:") && m.includes("20px은 SmartEditor에 없음 → 아래 19 / 위 24")));
  assert.ok(msgs.some((m) => m.includes("크기 역할(sizeRole) 없음")));
  assert.ok(msgs.some((m) => m.includes("역할 aside와 19px 방향이 다름")));
  assert.ok(msgs.some((m) => m.includes("“굵기만” 굵게 단독")));
  assert.ok(msgs.some((m) => m.startsWith("fact:1번째 줄 26자")));
  assert.ok(msgs.some((m) => m.includes("묶음 질문이 비어 있음")));
  assert.ok(msgs.some((m) => m.includes("사진 alt 없음")));
  assert.ok(!validate(doc, { bodyFontHasBold: true }).some((i) => i.message.includes("굵게 단독")));

  // 컨테이너(정보 글꼴) 안은 본문 기준의 줄 길이·굵게 단독 검사를 하지 않는다.
  const card = parse(`<Bundle id="B2" name="정보" question="q">
<VisitCard>
¶ P9
⟦📍 위치⟧¹ 아주 긴 주소가 한 줄에 들어가서 폰 한 줄보다 길다
  ¹ 굵게 · 라벨
</VisitCard>
</Bundle>`);
  assert.deepEqual(validate(card), []);
});

test("줄 끝 공백까지 원문 그대로 보존한다", () => {
  const src = '<Bundle id="b" name="n" question="q">\n\n¶ P1\n⟦기다리다가⟧¹ \n다음 줄\n  ¹ 적갈 · 시간\n</Bundle>\n';
  const doc = parse(src);
  const p = doc.bundles[0].nodes[0] as ParagraphNode;
  assert.deepEqual(p.lines, ["기다리다가 ", "다음 줄"]);
  assert.equal(serialize(doc, { legend: false }), src);
});

test("BlogDraft의 블록·span·reviewGroups를 마크업으로 옮기고 잃는 정보를 알린다", () => {
  const { doc, lost } = fromDraft({
    blocks: [
      { id: "h1", type: "text", role: "heading", text: "디저트" },
      { id: "p1", type: "text", text: "케이크가 정말 맛있었고\n케이크 또 먹고 싶어요", spans: [
        { text: "케이크", color: "#85613F", occurrence: "all" },
        { text: "없는 구절", background: "#fff8b2" },
      ] },
      { id: "img", type: "image", path: "/linked/cake.jpg", alt: "케이크" },
      { id: "p2", type: "text", text: "다음엔 다른 맛", spans: [{ text: "다른 맛", weight: 700 }] },
      { id: "src", type: "text", role: "source", text: "확인: 2026년" },
    ],
    reviewGroups: [
      { id: "g1", startBlockId: "h1", name: "디저트", question: "디저트는 어땠나" },
      { id: "g2", startBlockId: "p2", name: "다음", question: "다음엔 무엇을" },
    ],
  });
  assert.deepEqual(doc.bundles.map((b) => [b.id, b.nodes.length]), [["g1", 3], ["g2", 2]]);
  const p1 = doc.bundles[0].nodes[1] as ParagraphNode;
  assert.equal(p1.marks.length, 2);
  assert.ok(p1.marks.every((m) => m.style.color === "#85613f"));
  assert.deepEqual(lost, ["p1: 본문에서 못 찾은 강조 “없는 구절”"]);
  const text = serialize(doc);
  assert.match(text, /⟦케이크⟧¹가 정말 맛있었고\n⟦케이크⟧² 또 먹고 싶어요/);
  assert.match(text, /<Photo file="cake.jpg" alt="케이크"\/>/);
  assert.match(text, /<Source>\n¶ src\n확인: 2026년\n<\/Source>/);
  assert.deepEqual(parse(text), { ...doc, bundles: doc.bundles.map(b => ({ ...b, nodes: b.nodes.map(n => n.kind === "paragraph" ? { ...n, notes: [] } : { ...n, ...(n.children ? {children:n.children.map(p=>({...p,notes:[]}))} : {}) }) })) });
});

test("모든 컴포넌트 예시는 문법에 맞는 한 줄이다", () => {
  for (const [tag, spec] of Object.entries(COMPONENTS)) {
    if (spec.form === "container") continue;
    const doc = parse(`<Bundle id="b" name="n">\n${spec.example}\n</Bundle>`);
    const node = doc.bundles[0].nodes[0];
    assert.equal(node.kind === "component" && node.tag, tag);
  }
});

test("비율 혼합 콜라주는 행마다 사진 비율대로 폭을 나누고, ratios가 없으면 균등 격자를 유지한다", () => {
  assert.deepEqual(collageRows("2x2", 4), [2, 2]);
  assert.deepEqual(collageRows("2+1", 3), [2, 1]);
  assert.deepEqual(collageRows("2x1", 2), [2]);
  const mixed = `<Bundle id="B1" name="첫" question="q">
<Collage layout="2x2" files="a.jpg · b.jpg · c.jpg · d.jpg" alts="가 · 나 · 다 · 라" ratios="3:4 · 4:3 · 4:3 · 16:9"/>
<Collage layout="2x1" files="e.jpg · f.jpg" alts="마 · 바"/>
</Bundle>`;
  const doc = parse(mixed);
  assert.equal(serialize(doc), serialize(parse(serialize(doc))));
  assert.equal(validate(doc).filter((i) => i.level === "error").length, 0);
  const html = renderHtml(doc, { media: "m/" });
  assert.equal(html.match(/class="collage-row"/g)?.length, 2);
  assert.match(html, /<div style="--r:0.75"><img alt="가" src="m\/a.jpg"><\/div><div style="--r:1.3333"><img alt="나"/);
  assert.match(html, /--r:1.7778"><img alt="라"/);
  assert.match(html, /class="photo-grid4 even" data-component="PhotoCollage4" data-layout="2x1"/);
  const bad = parse(mixed.replace("3:4 · 4:3 · 4:3 · 16:9", "3:4 · 4:3").replace('layout="2x2"', 'layout="2+1"'));
  const errors = validate(bad).filter((i) => i.level === "error").map((i) => i.message);
  assert.ok(errors.some((m) => m.includes("Collage ratios")));
  assert.ok(errors.some((m) => m.includes("칸 수")));
  assert.match(renderHtml(bad), /photo-grid4 even/);
});

test("모르는 컴포넌트는 문서를 막지 않고 원문 줄 그대로 보존한다", () => {
  const src = [
    '<Bundle id="a" name="n" question="q">',
    '<Reel file="cheers.mp4" alt="잔을 맞대는 순간" ratio="4:5"/>',
    "",
    "¶ P1",
    "가",
    "",
    '<Later kind="x">',
    "",
    "¶ P2",
    "나",
    "",
    "</Later>",
    "<Memo>한 줄 <b>그대로</b></Memo>",
    "</Bundle>",
    "",
  ].join("\n");
  const doc = parse(src);
  assert.deepEqual(doc.bundles[0].nodes.map(n => n.kind === "unknown" ? n.source : n.kind), [
    '<Reel file="cheers.mp4" alt="잔을 맞대는 순간" ratio="4:5"/>', "paragraph", '<Later kind="x">', "paragraph", "</Later>", "<Memo>한 줄 <b>그대로</b></Memo>",
  ]);
  assert.equal(serialize(doc), src);
  assert.deepEqual(validate(doc).filter(i => i.level === "error"), []);
  assert.equal(validate(doc).filter(i => /모르는 컴포넌트 <Reel>/.test(i.message)).length, 1);
  for (const editable of [false, true]) {
    const html = renderHtml(doc, {}, editable);
    assert.match(html, /<aside data-bundle="a"[^>]* class="unknown-component"[^>]*><code>&lt;Reel file=&quot;cheers.mp4&quot;/);
    assert.match(html, /<code>&lt;Memo&gt;한 줄 &lt;b&gt;그대로&lt;\/b&gt;&lt;\/Memo&gt;<\/code>/);
    assert.doesNotMatch(html, /<b>그대로/);
  }
});
