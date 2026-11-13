import type { BuiltinDefinitionName } from "../../shared/workflow-definition";

/**
 * App-owned workflow definitions, selected with `builtinDefinition: "<name>"`.
 * The app owns the flow: steps, kinds, transitions, inputs/outputs, completion and
 * public, general instructions. Personal style, local documents and skill names
 * belong in a local guide file (docs/workflow-dsl.md#local-guides). The text is
 * parsed by the same validator as a YAML file and its SHA-256 is stored per run.
 * Keep step IDs and file names stable: existing workspaces are adopted by them.
 */
const blog = `# Built-in blog production definition (Reels Dashboard).
# Paths are relative to the article workspace. Media rules: docs/photo-first-drafting.md.
version: 1
id: blog
title: 블로그 · 촬영분에서 미리보기까지
entry: prepare
maxTransitions: 40
steps:
  - id: prepare
    title: 촬영분 분석·장면 목록
    kind: task
    instruction: >-
      brief.md와 작업 폴더의 자료 목록, 최신 사용자 정정을 읽는다.
      촬영분 전체를 Dashboard 분석(reels_start_analysis)으로 확인하고 실제 미리보기를 함께 본다.
      이미지를 직접 잘라 정적으로 분석하는 것으로 앱 분석을 대신하지 않는다.
      고른 컷만이 아니라 촬영분 전체 장면을 evidence/media-scenes.json에 올린다
      (장면마다 id·source·preview·observed·contextNotes, 형식과 preview 경로 규칙은 Reels Dashboard docs/photo-first-drafting.md의 Preparation).
      경험은 추정하지 않고 빠진 것만 experience-form.json 질문으로 분리한다. 이미 제출된 답은 다시 묻지 않는다.
      질문은 두 경우에만 한다: 사용자만 아는 경험(맛·양·동행·의도)이 비었을 때,
      사용자 진술과 기록이 본문 문장을 바꿀 만큼 어긋날 때.
      규칙·선례·확인된 사실로 하나로 정해지는 것은 묻지 않고 정한 뒤 결정을 한 줄로 기록한다.
      물을 것이 하나도 없으면 질문을 지어내지 않고, 폼에는 "더 남기거나 바로잡을 경험이 있는지"를 묻는 확인 질문 하나만 둔다(폼은 질문이 하나 이상 있어야 한다).
    tools:
      - {server: reels_dashboard, name: reels_get_content, purpose: 콘텐츠 카드와 연결 자료 확인}
      - {server: reels_dashboard, name: reels_photos_search, purpose: 촬영 시각·위치로 빠진 원본 찾기}
      - {server: reels_dashboard, name: reels_start_analysis, purpose: 촬영분 장면·OCR·얼굴 분석}
    inputs: [brief.md]
    outputs: [evidence/media-scenes.json, experience-form.json]
    completion: [촬영분 전체가 장면 목록에 있음, 확인되지 않은 경험은 질문으로 분리]
    on: {done: experience}
  - id: experience
    title: 내 경험 입력
    kind: input
    instruction: 사진과 확인된 사실을 보고 실제 경험을 입력한다. 기억나지 않음과 제외도 유효한 답변이다.
    formFile: experience-form.json
    completion: [사용자가 공통 폼에 응답하고 제출]
    on: {done: draft}
  - id: draft
    title: 사진 구성·원고
    kind: task
    instruction: >-
      제출 답변 원문과 media-scenes.json을 읽고 사진 구성을 먼저 정한 뒤 문장을 쓴다
      (구성 규칙과 story-media-plan.json 형식은 docs/photo-first-drafting.md의 Draft composition이 정본).
      사진·영상은 최대한 많이 쓴다. omit은 연사·같은 장면 중복, 가림 처리(스티커·크롭)로도 가릴 수 없는 얼굴, 사실 오단정뿐이다.
      동작 영상은 넣을지 묻지 않고 무음 GIF(reels_convert_gif, 원본 전체 길이)로 만든다.
      소리 자체가 경험인 장면은 무음 GIF와 함께 소리 있는 짧은 영상도 두고 소리를 켜 보라는 안내를 붙인다.
      사람 목소리가 들어갔는지는 에이전트가 오디오를 도구로 먼저 확인하고, 목소리 구간이 있으면 시각과 함께 보고한다. 불필요한 앞뒤는 자른다.
      모든 장면을 evidence/story-media-plan.json에 use/omit/hold로 결정하고 article.markup.md와 story-layout.md에 반영한다.
      채택한 사진·GIF는 바로 앞이나 뒤의 문장 또는 블록과 짝을 이룬다. 짝 문장은 사진만으로는 알 수 없는 경험·정보를 더하는 문장이고,
      사용자 답 문장이 그 사진 옆에 오면 그 문장이 짝이다. 메뉴 박스·표처럼 같은 내용을 전하는 블록 옆의 증빙 사진(영수증·메뉴판)은 그 블록이 짝이다.
      사진을 가리키기만 하는 문장("~는 이렇게 나왔어요", "~ 사진이에요")과 사진·영수증에서 읽히는 품목명·상표·수량을 옮겨 적은 줄은 짝으로 세지 않고 쓰지 않는다.
      문장은 사진에 보이는 것과 사용자 답에 근거하고 감상을 지어내지 않는다.
      맛집 글은 촬영분에서 메뉴판·영수증 컷을 찾아보고, 없으면 확인한 메뉴·가격 근거를 작업 폴더에 남긴다. 외부 자료를 본문에 쓸지는 로컬 가이드를 따른다.
      답에 없는 맛·양·동행 반응·감상은 만들지 않는다. 사진 추가·교체 요청도 이 단계에서 같은 계획을 고쳐 처리한다.
      blog-markup check(docs/blog-markup-source.md)를 통과시킨다.
    tools:
      - {server: reels_dashboard, name: reels_convert_gif, purpose: 동작 영상 무음 GIF}
    inputs: [evidence/media-scenes.json]
    outputs: [article.markup.md, story-layout.md, evidence/story-media-plan.json]
    completion: [모든 장면 결정, 채택한 사진마다 짝 문장 또는 블록(가리키기 문장 없음), 사용자 원문 기반 문장, blog-markup check 통과]
    on: {done: image_review}
  - id: image_review
    title: 이미지 구성 검토
    kind: review
    instruction: >-
      media-scenes.json의 미리보기와 원고에 들어간 실제 사진·GIF 파일을 직접 열어 본다.
      텍스트·계획 파일만 읽고 이미지 통과를 주장하지 않으며, 열어 본 파일 목록을 보고서에 적는다.
      검사 항목: (1) story-media-plan.json의 묶음·순서·역할이 article.markup.md의 실제 사진 순서·묶음과 일치하는가,
      (2) 같은 주제의 전체·행동·디테일 컷을 찾아봤고 omit 이유가 중복·얼굴·사실 오단정뿐인가,
      (3) 모든 사진·GIF가 앞뒤 문장 또는 블록과 짝을 이루는가(짝 없이 놓인 컷은 revise. 짝을 만들려고 문장을 새로 쓰지 말고 자리 이동·같은 장면 묶음 편입을 먼저 제안한다). 사진을 가리키기만 하거나 사진 속 글자·상표를 옮겨 적은 줄은 짝으로 세지 않고 삭제 대상으로 적는다,
      (4) 맛집 글이면 메뉴판·영수증 컷을 탐색했고 결과(사용·없음)와 메뉴·가격 근거가 기록돼 있는가,
      (5) 식별 가능한 얼굴과 영수증 사업자번호 같은 개인정보가 있는 컷을 모두 식별했고 story-media-plan.json handling에 가림 계획이 있는가.
      공개용 사본은 layout에서 만들므로 여기서는 계획만 보고, 실제 가림 결과는 visual_review가 확인한다.
      대상 파일은 고치지 않는다. 원본 탐색 범위·채택/탈락 근거·크롭 판단은 reviews/image-plan-{attempt}.md에, 판정은 reviews/image-review-{attempt}.md에 쓴다.
    inputs: [article.markup.md, story-layout.md, evidence/media-scenes.json, evidence/story-media-plan.json]
    outputs: ['reviews/image-review-{attempt}.md', 'reviews/image-plan-{attempt}.md']
    completion: [실제 이미지 파일을 열어 본 목록 기록, 다섯 검사 항목별 판정과 근거, 수정 항목 또는 통과 근거 기록]
    on: {pass: text_review, revise: draft}
  - id: text_review
    title: 문안·의미 검토
    kind: review
    instruction: >-
      작업 폴더의 작성 기준과 사용자 답변 원문을 대조해 전 문단·전환·사실·주체·말투를 검토한다. 대상은 고치지 않고 보고서만 쓴다.
      맛집 글은 메뉴·가격 정보도 확인한다: 주문 메뉴와 가격이 근거와 함께 있고 가격·영업 정보의 근거와 기준일이 작업 폴더에 기록됐는가(본문 표기 방식은 로컬 가이드를 따른다),
      메뉴판·영수증 사진이 있으면 메뉴 박스 값과 맞는가, 술·사이드 같은 주문 항목이 해당 사진·문단과 같은 자리에 있는가(사진 옆에 품목을 다시 나열하라는 뜻은 아니다).
    inputs: [article.markup.md, story-layout.md, evidence/story-media-plan.json]
    outputs: ['reviews/text-review-{attempt}.md']
    completion: [사실·주체·말투 검토, 맛집 글의 메뉴·가격·메뉴판 확인, 수정 항목 또는 통과 근거 기록]
    on: {pass: layout, revise: draft}
  - id: layout
    title: 화면 구성
    kind: task
    instruction: >-
      story-media-plan.json의 채택·순서·묶음을 이어받아(docs/photo-first-drafting.md의 Review and layout)
      원본에서 공개용 파생본(위치 메타데이터 제거·얼굴 가림·크롭)을 만들고
      blog-markup render로 publishing/smarteditor-draft-layout.html을 갱신한다. PC·모바일 화면을 실제로 확인해 보고서에 남긴다.
    inputs: [article.markup.md, evidence/story-media-plan.json]
    outputs: [publishing/smarteditor-draft-layout.html, reviews/layout-review.md]
    completion: [실제 화면 확인과 근거 기록]
    on: {done: visual_review}
  - id: visual_review
    title: 최종 화면 검토
    kind: review
    instruction: >-
      미리보기를 PC·모바일 폭으로 열어 사진·서식·얼굴 처리를 검사한다. 렌더 성공을 화면 통과로 대신하지 않는다.
      미리보기는 캐시를 비우고 다시 읽어 바뀐 사진이 실제로 보이는지 확인한다.
      소리 영상의 목소리 확인은 사용자 답을 기다리는 수정 사유로 걸지 않는다.
      image_review가 가림 계획을 세운 컷은 공개용 사본을 확대해 얼굴 가림과 영수증 개인정보 잘림을 실제로 확인한다.
      대상 파일은 고치지 않는다. 외부 게시·발행은 하지 않는다.
    inputs: [publishing/smarteditor-draft-layout.html]
    outputs: ['reviews/visual-review-{attempt}.md']
    completion: [실제 화면 확인, 가림 계획 컷의 실제 가림 확인, 통과 또는 수정 근거 기록]
    on: {pass: $complete, revise: layout}
`;

export const builtinDefinitions: Record<BuiltinDefinitionName, string> = {
  blog,
};
