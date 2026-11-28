import type { BuiltinDefinitionName } from "../../shared/workflow-definition";

/**
 * App-owned workflow definitions, selected with `builtinDefinition: "<name>"`.
 * The app owns the flow: steps, kinds, transitions, inputs/outputs, completion and
 * public, general instructions. Personal style, local documents and skill names
 * belong in a local guide file (docs/workflow-dsl.md#local-guides). The text is
 * parsed by the same validator as a YAML file and its SHA-256 is stored per run.
 * Keep step IDs and file names stable: existing workspaces are adopted by them.
 */

/*
 * Review and layout contracts shared by `blog` and `blog-v3`, so v3 runs the same
 * image review, text review, layout and visual review as the blog definition.
 * Each fragment is a run of folded-scalar lines indented for a step instruction.
 */
const imageReviewChecks = `      media-scenes.json의 미리보기와 원고에 들어간 실제 사진·GIF 파일을 직접 열어 본다.
      텍스트·계획 파일만 읽고 이미지 통과를 주장하지 않으며, 열어 본 파일 목록을 보고서에 적는다.
      검사 항목: (1) story-media-plan.json의 묶음·순서·역할이 article.markup.md의 실제 사진 순서·묶음과 일치하는가,
      (2) 같은 주제의 전체·행동·디테일 컷을 찾아봤고 omit 이유가 중복·얼굴·사실 오단정뿐인가,
      (3) 모든 사진·GIF가 앞뒤 문장 또는 블록과 짝을 이루는가(짝 없이 놓인 컷은 revise. 짝을 만들려고 문장을 새로 쓰지 말고 자리 이동·같은 장면 묶음 편입을 먼저 제안한다). 사진을 가리키기만 하거나 사진 속 글자·상표를 옮겨 적은 줄은 짝으로 세지 않고 삭제 대상으로 적는다,
      (4) 맛집 글이면 메뉴판·영수증 컷을 탐색했고 결과(사용·없음)와 메뉴·가격 근거가 기록돼 있는가,
      (5) 식별 가능한 얼굴과 영수증 사업자번호 같은 개인정보가 있는 컷을 모두 식별했고 story-media-plan.json handling에 가림 계획이 있는가.`;
const textReviewChecks = `      작업 폴더의 작성 기준과 사용자 답변 원문을 대조해 전 문단·전환·사실·주체·말투를 검토한다. 대상은 고치지 않고 보고서만 쓴다.
      맛집 글은 메뉴·가격 정보도 확인한다: 주문 메뉴와 가격이 근거와 함께 있고 가격·영업 정보의 근거와 기준일이 작업 폴더에 기록됐는가(본문 표기 방식은 로컬 가이드를 따른다),
      메뉴판·영수증 사진이 있으면 메뉴 박스 값과 맞는가, 술·사이드 같은 주문 항목이 해당 사진·문단과 같은 자리에 있는가(사진 옆에 품목을 다시 나열하라는 뜻은 아니다).`;
const layoutWork = `      story-media-plan.json의 채택·순서·묶음을 이어받아(docs/photo-first-drafting.md의 Review and layout)
      원본에서 공개용 파생본(위치 메타데이터 제거·얼굴 가림·크롭)을 만들고
      blog-markup render로 publishing/smarteditor-draft-layout.html을 갱신한다. PC·모바일 화면을 실제로 확인해 보고서에 남긴다.`;
const visualReviewChecks = `      미리보기를 PC·모바일 폭으로 열어 사진·서식·얼굴 처리를 검사한다. 렌더 성공을 화면 통과로 대신하지 않는다.
      미리보기는 캐시를 비우고 다시 읽어 바뀐 사진이 실제로 보이는지 확인한다.
      소리 영상의 목소리 확인은 사용자 답을 기다리는 수정 사유로 걸지 않는다.
      image_review가 가림 계획을 세운 컷은 공개용 사본을 확대해 얼굴 가림과 영수증 개인정보 잘림을 실제로 확인한다.`;

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
      촬영분은 방문 단위로 묶어 가져오는 것이 기본이다. 콘텐츠 카드에 이 방문의 Photos 원본이 아직 없으면
      촬영 날짜를 색인(reels_photos_index)하고 방문 그룹을 고른 뒤 reels_import_photos_bundle로 그룹의 사진·영상·Live Photo 전체를 카드에 원본 복사로 가져온다.
      Photos 원본은 복사만 하고 바꾸지 않는다. inspect 미리보기나 영상만 가져오기로 대신하지 않는다.
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
      - {server: reels_dashboard, name: reels_photos_index, purpose: 촬영 날짜 색인}
      - {server: reels_dashboard, name: reels_photos_group, purpose: 방문 그룹의 사진·영상 확인}
      - {server: reels_dashboard, name: reels_import_photos_bundle, purpose: 방문 그룹 사진·영상·Live Photo 원본을 카드에 묶어 복사}
      - {server: reels_dashboard, name: reels_photos_search, purpose: 촬영 시각·위치로 빠진 원본 찾기}
      - {server: reels_dashboard, name: reels_start_analysis, purpose: 촬영분 장면·OCR·얼굴 분석}
    inputs: [brief.md]
    outputs: [evidence/media-scenes.json, experience-form.json]
    completion: [방문 Photos 묶음(사진·영상)이 카드에 원본 복사로 연결됨, 촬영분 전체가 장면 목록에 있음, 확인되지 않은 경험은 질문으로 분리]
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
      같은 장면 묶음(Bundle·Collage)은 묶음의 이야기 문장 하나가 묶음 전체의 짝이다. 짝을 만들려고 사진마다 문장을 새로 쓰지 않는다.
      사진을 가리키기만 하는 문장("~는 이렇게 나왔어요", "~ 사진이에요")과 사진·영수증에서 읽히는 품목명·상표·수량을 옮겨 적은 줄은 짝으로 세지 않고 쓰지 않는다.
      문장은 사진에 보이는 것과 사용자 답에 근거하고 감상을 지어내지 않는다.
      맛집 글은 촬영분에서 메뉴판·영수증 컷을 찾아보고, 없으면 확인한 메뉴·가격 근거를 작업 폴더에 남긴다. 외부 자료를 본문에 쓸지는 로컬 가이드를 따른다.
      답에 없는 맛·양·동행 반응·감상은 만들지 않는다. 사진 추가·교체 요청도 이 단계에서 같은 계획을 고쳐 처리한다.
      blog-markup check(docs/blog-markup-source.md)를 통과시킨다.
    tools:
      - {server: reels_dashboard, name: reels_convert_gif, purpose: 동작 영상 무음 GIF}
    inputs: [evidence/media-scenes.json]
    outputs: [article.markup.md, story-layout.md, evidence/story-media-plan.json]
    completion: [모든 장면 결정, 채택한 사진·묶음마다 짝 문장 또는 블록(가리키기 문장 없음), 사용자 원문 기반 문장, blog-markup check 통과]
    on: {done: image_review}
  - id: image_review
    title: 이미지 구성 검토
    kind: review
    instruction: >-
${imageReviewChecks}
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
${textReviewChecks}
    inputs: [article.markup.md, story-layout.md, evidence/story-media-plan.json]
    outputs: ['reviews/text-review-{attempt}.md']
    completion: [사실·주체·말투 검토, 맛집 글의 메뉴·가격·메뉴판 확인, 수정 항목 또는 통과 근거 기록]
    on: {pass: layout, revise: draft}
  - id: layout
    title: 화면 구성
    kind: task
    instruction: >-
${layoutWork}
    inputs: [article.markup.md, evidence/story-media-plan.json]
    outputs: [publishing/smarteditor-draft-layout.html, reviews/layout-review.md]
    completion: [실제 화면 확인과 근거 기록]
    on: {done: visual_review}
  - id: visual_review
    title: 최종 화면 검토
    kind: review
    instruction: >-
${visualReviewChecks}
      대상 파일은 고치지 않는다. 외부 게시·발행은 하지 않는다.
    inputs: [publishing/smarteditor-draft-layout.html]
    outputs: ['reviews/visual-review-{attempt}.md']
    completion: [실제 화면 확인, 가림 계획 컷의 실제 가림 확인, 통과 또는 수정 근거 기록]
    on: {pass: $complete, revise: layout}
`;

/**
 * Blog v3: the whole blog pipeline on a long draft, with only the writer's experience and
 * content corrections moved later. The long draft keeps every draft contract but asks
 * nothing up front and marks unconfirmed experience as [추정]; it then goes through the
 * same image review, text review (style and emphasis) and layout as `blog`. The writer
 * reads that polished, laid-out draft with its photos and writes down memories and the
 * state of the post; a union merge ↔ prune loop folds them in and cuts branches; the
 * changed text and photos go through image review, text review and layout again before
 * the visual review.
 */
const blogV3 = `# Built-in blog v3 definition (Reels Dashboard): the full blog pipeline on a long draft,
# with experience and content corrections moved after it.
# long_draft → image_review → text_review → layout → recall_prep → recall → merge ↔ prune
# → final_image_review → final_text_review → final_layout → visual_review.
# Paths are relative to the article workspace. Media rules: docs/photo-first-drafting.md.
version: 1
id: blog-v3
title: 블로그 v3 · 긴 초안 전 공정 → 기억 되살리기 → 머지·가지치기 → 마무리 공정
entry: prepare
maxTransitions: 80
steps:
  - id: prepare
    title: 촬영분 분석·장면 목록
    kind: task
    instruction: >-
      brief.md와 작업 폴더의 자료 목록, 최신 사용자 정정을 읽는다.
      촬영분은 방문 단위로 묶어 가져오는 것이 기본이다. 콘텐츠 카드에 이 방문의 Photos 원본이 아직 없으면
      촬영 날짜를 색인(reels_photos_index)하고 방문 그룹을 고른 뒤 reels_import_photos_bundle로 그룹의 사진·영상·Live Photo 전체를 카드에 원본 복사로 가져온다.
      Photos 원본은 복사만 하고 바꾸지 않는다. inspect 미리보기나 영상만 가져오기로 대신하지 않는다.
      촬영분 전체를 Dashboard 분석(reels_start_analysis)으로 확인하고 실제 미리보기를 함께 본다.
      고른 컷만이 아니라 촬영분 전체 장면을 evidence/media-scenes.json에 올린다
      (형식과 preview 경로 규칙은 Reels Dashboard docs/photo-first-drafting.md의 Preparation).
      v3는 여기서 경험을 묻지 않는다. 사용자 기억은 다듬어진 긴 초안을 읽는 recall 단계에서 받는다.
    tools:
      - {server: reels_dashboard, name: reels_get_content, purpose: 콘텐츠 카드와 연결 자료 확인}
      - {server: reels_dashboard, name: reels_photos_index, purpose: 촬영 날짜 색인}
      - {server: reels_dashboard, name: reels_photos_group, purpose: 방문 그룹의 사진·영상 확인}
      - {server: reels_dashboard, name: reels_import_photos_bundle, purpose: 방문 그룹 사진·영상·Live Photo 원본을 카드에 묶어 복사}
      - {server: reels_dashboard, name: reels_photos_search, purpose: 촬영 시각·위치로 빠진 원본 찾기}
      - {server: reels_dashboard, name: reels_start_analysis, purpose: 촬영분 장면·OCR·얼굴 분석}
    inputs: [brief.md]
    outputs: [evidence/media-scenes.json]
    completion: [방문 Photos 묶음(사진·영상)이 카드에 원본 복사로 연결됨, 촬영분 전체가 장면 목록에 있음]
    on: {done: long_draft}
  - id: long_draft
    title: 긴 초안 (사진 구성·원고)
    kind: task
    instruction: >-
      blog 정의의 draft와 같은 계약으로 쓰되 경험을 먼저 묻지 않고 내용을 넉넉히 늘린 긴 초안을 쓴다. 경험·내용 보정만 뒤의 recall과 merge로 미루고, 나머지 공정은 이 초안부터 모두 적용한다.
      media-scenes.json, 확인된 사실 자료, 작업 폴더에 이미 있는 사용자 진술을 읽고 사진 구성을 먼저 정한 뒤 문장을 쓴다
      (구성 규칙과 story-media-plan.json 형식은 docs/photo-first-drafting.md의 Draft composition이 정본).
      사진·영상은 최대한 많이 쓴다. omit은 연사·같은 장면 중복, 가림 처리(스티커·크롭)로도 가릴 수 없는 얼굴, 사실 오단정뿐이다.
      동작 영상은 넣을지 묻지 않고 무음 GIF(reels_convert_gif, 원본 전체 길이)로 만든다.
      소리 자체가 경험인 장면은 무음 GIF와 함께 소리 있는 짧은 영상도 두고 소리를 켜 보라는 안내를 붙인다.
      사람 목소리가 들어갔는지는 에이전트가 오디오를 도구로 먼저 확인하고, 목소리 구간이 있으면 시각과 함께 보고한다. 불필요한 앞뒤는 자른다.
      모든 장면을 evidence/story-media-plan.json에 use/omit/hold로 결정하고 article.markup.md와 story-layout.md에 반영한다.
      식별 가능한 얼굴, 영수증 사업자번호, 휴대폰 화면처럼 가릴 컷은 story-media-plan.json handling에 가림 계획을 적는다.
      원고는 사진 흐름을 따라 장면 단위 섹션(소제목)으로 나누고, 섹션마다 사진에서 보이는 것, 확인된 사실, 그 장면에서 있었을 법한 경험의 갈래를 넉넉히 펼친다.
      완성 원고에 들어갈 요소(로컬 가이드가 정한 고정 요소, 맛집 글의 메뉴 박스, 제목 후보와 맺음 문장, 태그, 같은 모임·연재 글 링크)는 처음부터 모두 넣는다. 압축과 가지치기는 뒤 단계가 하므로 여기서 빼지 않는다.
      채택한 사진·GIF는 바로 앞이나 뒤의 문장 또는 블록과 짝을 이룬다. 짝 문장은 사진만으로는 알 수 없는 경험·정보를 더하는 문장이고,
      사용자 진술 문장이 그 사진 옆에 오면 그 문장이 짝이다. 메뉴 박스·표처럼 같은 내용을 전하는 블록 옆의 증빙 사진(영수증·메뉴판)은 그 블록이 짝이다.
      같은 장면 묶음(Bundle·Collage)은 묶음의 이야기 문장 하나가 묶음 전체의 짝이다. 짝을 만들려고 사진마다 문장을 새로 쓰지 않는다.
      사진을 가리키기만 하는 문장("~는 이렇게 나왔어요", "~ 사진이에요")과 사진·영수증에서 읽히는 품목명·상표·수량을 옮겨 적은 줄은 짝으로 세지 않고 쓰지 않는다.
      문장은 사진에 보이는 것, 확인된 사실, 이미 있는 사용자 진술에 근거한다. 사용자 진술이나 사진·기록으로 확인되지 않은 경험·맛·양·동행 반응·감상·추론은 사실처럼 쓰지 않고
      줄(문장)마다 끝에 [추정]을 붙인 갈래로 남긴다. 여러 줄 문단에서 첫 줄에만 붙이지 않는다. 같은 섹션에서 서로 다른 갈래(예 첫인상 A/B)가 가능하면 둘 다 쓴다. 고르는 것은 사용자의 기억과 merge가 한다.
      맛집 글은 촬영분에서 메뉴판·영수증 컷을 찾아보고, 없으면 확인한 메뉴·가격 근거를 작업 폴더에 남긴다. 외부 자료를 본문에 쓸지는 로컬 가이드를 따른다.
      사진 추가·교체 요청과 image_review·text_review의 revise 항목도 이 단계에서 같은 계획을 고쳐 처리한다.
      blog-markup check(docs/blog-markup-source.md)를 통과시킨다.
    tools:
      - {server: reels_dashboard, name: reels_convert_gif, purpose: 동작 영상 무음 GIF}
    inputs: [evidence/media-scenes.json]
    outputs: [article.markup.md, story-layout.md, evidence/story-media-plan.json]
    completion: [모든 장면 결정, 장면 단위 섹션으로 나뉜 긴 초안, 고정 요소·메뉴 박스·제목·맺음 문장·태그 포함, 가림 계획 기록, 채택한 사진·묶음마다 짝 문장 또는 블록(가리키기 문장 없음), 확인 안 된 경험 줄마다 추정 표시, blog-markup check 통과]
    on: {done: image_review}
  - id: image_review
    title: 이미지 구성 검토
    kind: review
    instruction: >-
${imageReviewChecks}
      긴 초안의 [추정] 줄은 확인되지 않았다는 이유로 지우라고 하지 않는다. 남길지는 recall과 merge가 정한다.
      공개용 사본은 layout에서 만들므로 여기서는 계획만 보고, 실제 가림 결과는 layout과 visual_review가 확인한다.
      대상 파일은 고치지 않는다. 원본 탐색 범위·채택/탈락 근거·크롭 판단은 reviews/image-plan-{attempt}.md에, 판정은 reviews/image-review-{attempt}.md에 쓴다.
    inputs: [article.markup.md, story-layout.md, evidence/media-scenes.json, evidence/story-media-plan.json]
    outputs: ['reviews/image-review-{attempt}.md', 'reviews/image-plan-{attempt}.md']
    completion: [실제 이미지 파일을 열어 본 목록 기록, 다섯 검사 항목별 판정과 근거, 수정 항목 또는 통과 근거 기록]
    on: {pass: text_review, revise: long_draft}
  - id: text_review
    title: 문안·의미 검토
    kind: review
    instruction: >-
${textReviewChecks}
      v3에서 이 단계가 대조할 사용자 원문은 작업 폴더에 이미 있는 사용자 진술이다. 사용자 답이 없다는 이유로 검토를 미루지 않는다.
      문체·전환·말투와 강조(색·굵게)는 [추정] 줄까지 같은 기준으로 판정한다. 강조가 빠진 문장과 과한 문장을 위치와 함께 적는다.
      [추정] 줄은 지우라고 하지 않고 표시를 떼지도 않는다. 남길지는 recall과 merge가 정한다.
    inputs: [article.markup.md, story-layout.md, evidence/story-media-plan.json]
    outputs: ['reviews/text-review-{attempt}.md']
    completion: [사실·주체·말투 검토, 강조 판정, 맛집 글의 메뉴·가격·메뉴판 확인, 추정 줄 보존, 수정 항목 또는 통과 근거 기록]
    on: {pass: layout, revise: long_draft}
  - id: layout
    title: 화면 구성
    kind: task
    instruction: >-
${layoutWork}
      story-media-plan.json handling의 가림 계획(얼굴·영수증 개인정보·휴대폰 화면)을 공개용 사본에 실제로 적용하고, 동작 GIF와 스티커처럼 로컬 가이드가 정한 화면 요소도 이 단계에서 넣는다.
      사용자가 recall에서 이 화면의 문장과 사진을 읽으므로 [추정] 표시는 그대로 둔다.
    inputs: [article.markup.md, evidence/story-media-plan.json]
    outputs: [publishing/smarteditor-draft-layout.html, reviews/layout-review.md]
    completion: [가림 계획 컷의 공개용 사본 적용, 실제 화면 확인과 근거 기록]
    on: {done: recall_prep}
  - id: recall_prep
    title: 기억 폼 준비
    kind: task
    instruction: >-
      문체·강조·사진 검토와 화면 구성을 마친 article.markup.md를 사용자가 읽을 긴 초안으로 고정한다. 지금 내용을 그대로 drafts/long.markup.md에 복사한다(merge가 사용자 답과 대조하는 기준이다).
      그다음 recall-form.json을 만든다: 섹션 하나가 질문 하나다(최대 30개, 많으면 이웃 섹션을 묶는다).
      질문 section에는 섹션 번호와 소제목, help에는 그 섹션의 다듬어진 문장을 [추정] 표시와 함께 그대로(2000자 이내, 첫 섹션에는 제목 후보도) 넣고,
      images에는 layout이 만든 그 섹션의 공개용 사진·GIF 첫 프레임과 판단이 필요한 hold 장면 사진을 최대 4장(JPEG/PNG/WebP, 4MB 이하, 배치 역할을 적은 caption) 붙인다.
      prompt는 그때 떠오르는 경험과 이 섹션의 글 상태(맞는 것·틀린 것·뺄 것·더할 것·합치거나 바꾸고 싶은 구성)를 떠오르는 대로 적게 열어 두고 답을 유도하지 않는다. 모든 질문은 required false다.
      마지막 질문은 섹션에 없던 기억과 글 전체의 상태(쳐낼 잔가지, 합칠 섹션, 사진 배치, 제목·말투·흐름)를 나열받는 자유 질문 하나로 둔다. facts에는 확인된 사실만 출처와 함께 넣는다.
    inputs: [article.markup.md, story-layout.md, evidence/story-media-plan.json, publishing/smarteditor-draft-layout.html]
    outputs: [drafts/long.markup.md, recall-form.json]
    completion: [drafts/long.markup.md가 다듬어진 article.markup.md와 같음, 섹션별 다듬어진 문장·공개용 사진·글 상태 안내가 붙은 recall 질문, 마지막 자유 질문]
    on: {done: recall}
  - id: recall
    title: 읽으며 기억 되살리기·글 상태 나열
    kind: input
    instruction: >-
      섹션마다 다듬어진 문장과 사진을 보며 그때를 떠올리고 글 상태를 점검한다.
      기억나는 것·틀린 것·빼도 되는 것·더하고 싶은 것뿐 아니라 합치고 싶은 섹션, 사진 배치, 제목·말투처럼 글 상태에 대한 메모도 떠오르는 대로 쭉 적는다.
      [추정] 문장은 맞으면 맞다고, 아니면 아니라고 적거나 내 말로 고쳐 쓴다. 직접 고쳐 쓴 문장은 뜻과 말투를 그대로 살린다.
      정리된 문장이 아니어도 되고, 기억나지 않음과 제외도 유효한 답이다.
    formFile: recall-form.json
    completion: [사용자가 섹션별 기억과 글 상태를 공통 폼에 적고 제출]
    on: {done: merge}
  - id: merge
    title: 유니온 머지
    kind: task
    instruction: >-
      첫 실행에서는 drafts/long.markup.md(사용자가 읽은 다듬어진 긴 초안)와 제출된 recall 답변 원문(작업 폴더의 experience-answers-*.json 중 최신)을 섹션 단위로 합쳐 article.markup.md를 쓴다.
      prune·final_image_review·final_text_review에서 revise로 돌아온 경우에는 긴 초안에서 다시 합치지 않고, 현재 article.markup.md를 정본으로 삼아 돌려보낸 단계의 최신 보고서
      (reviews/prune-*.md, reviews/final-image-review-*.md·final-image-plan-*.md, reviews/final-text-review-*.md) 목록을 반영한다.
      합치는 규칙: (1) 사용자 답의 기억과 글 상태 지시(더할 내용, 합칠 섹션, 순서, 사진 배치, 제목 선택, 말투 메모)는 빠짐없이 반영한다. 사용자 말투와 고유 표현은 살린다.
      (2) 사용자 답이 초안과 다르면 사용자 답이 이긴다. (3) 사용자가 "빼"·"아님"이라고 한 문장과 사진은 뺀다.
      (4) 사용자가 확인한 [추정] 갈래는 표시를 떼고 사용자 말로 바꾸고, 답이 없는 [추정] 갈래는 지운다. 공개 원고에 [추정]이 남지 않는다.
      (5) 사진·기록으로 확인된 사실 문장과 사진, 앞 공정에서 다듬은 문체·강조는 유지한다. 새 감상을 지어내지 않는다.
      (6) 답 없는 갈래를 지운 뒤 한두 줄만 남은 이웃 섹션은 첫 머지에서부터 같은 흐름의 묶음으로 합친다. 서로 다른 정보를 주는 사진은 버리지 않고 같은 묶음의 콜라주로 옮기며, 묶음의 이야기 문장 하나가 묶음 전체의 짝이 된다.
      사진을 빼거나 옮기거나 묶음을 바꾸면 evidence/story-media-plan.json을 갱신하고, 사진 흐름과 섹션 구성은 story-layout.md에 쓴다.
      섹션마다 사용자 답에서 가져온 것과 합치거나 지운 것을(revise로 돌아왔으면 반영한 항목과 보류한 항목·사유를) reviews/merge-log.md에 적는다. 바뀌거나 새로 들어온 문장·사진은 merge-log.md에서 알아볼 수 있게 적는다(뒤의 마무리 공정이 먼저 본다).
      blog-markup check(docs/blog-markup-source.md)를 통과시킨다.
    inputs: [drafts/long.markup.md, evidence/media-scenes.json]
    outputs: [article.markup.md, story-layout.md, evidence/story-media-plan.json, reviews/merge-log.md]
    completion: [사용자 답의 기억과 글 상태 지시가 모두 반영됨, 사용자가 뺀 문장·사진이 빠짐, 추정 표시 없음, 파편 섹션 통합과 섹션별 머지 기록(바뀐 문장·사진 표시), blog-markup check 통과]
    on: {done: prune}
  - id: prune
    title: 잔가지 쳐내기
    kind: review
    instruction: >-
      article.markup.md를 처음부터 끝까지 읽고, media-scenes.json의 미리보기와 원고에 들어간 실제 사진·GIF 파일을 직접 열어 본다.
      텍스트·계획 파일만 읽고 통과를 주장하지 않으며, 열어 본 이미지 파일 목록을 보고서에 적는다.
      글의 줄기(이 가게·장소를 왜 가는지, 사용자가 기억한 경험과 확인된 핵심 장면)에 붙지 않는 잔가지를 찾는다.
      문장 잔가지: 같은 말을 되풀이하는 문장, 사진을 가리키기만 하는 문장, 사진·영수증 속 글자·상표·수량을 옮겨 적은 줄, 사용자 답에도 기록에도 없는 감상, 줄기와 상관없는 곁가지 설명.
      구조 잔가지: 너무 잘게 나뉜 섹션은 사진을 버리지 말고 이웃 섹션과 합치거나 같은 장면 묶음으로 옮기도록 제안한다.
      사진을 omit으로 쳐내는 것은 사용자가 빼라고 한 컷, 같은 장면 중복, 가릴 수 없는 얼굴, 사실 오단정뿐이다.
      사용자 답에서 온 문장은 잔가지로 치지 않고, 꼭 필요하면 위치 이동만 제안한다. merge-log.md에 보류 사유가 기록된 항목은 같은 사유로 다시 지적하지 않는다.
      최소 항목: (1) 남은 [추정] 0건, (2) story-media-plan.json과 원고의 사진 순서·묶음 일치, (3) 사진·묶음마다 앞뒤 문장 또는 블록과의 짝(짝이 없으면 새 문장 대신 자리 이동·묶음 편입 제안),
      (4) 맛집 글의 메뉴·가격 근거와 메뉴 박스 일치, (5) 식별 가능한 얼굴·영수증 개인정보·휴대폰 화면 컷의 가림 계획(story-media-plan.json handling).
      대상 파일은 고치지 않는다. 쳐내거나 합칠 문장·섹션·사진을 위치와 이유와 함께 reviews/prune-{attempt}.md에 쓴다.
      최소 항목에 미충족이 있거나 쳐낼 잔가지·합칠 파편 섹션이 남았으면 revise(merge가 반영), 최소 항목을 모두 충족하고 새로 쳐낼 잔가지가 없으면 pass다.
    inputs: [article.markup.md, story-layout.md, evidence/story-media-plan.json, reviews/merge-log.md]
    outputs: ['reviews/prune-{attempt}.md']
    completion: [실제 열어 본 이미지 파일 목록, 잔가지·섹션 통합 목록(위치·이유) 또는 통과 근거, 사용자 답 문장 보존 확인, 최소 다섯 항목(추정 0건·계획 일치·사진 짝·메뉴 가격·가림 계획) 판정]
    on: {pass: final_image_review, revise: merge}
  - id: final_image_review
    title: 머지 뒤 이미지 구성 재검토
    kind: review
    instruction: >-
      merge·prune을 거친 원고에 image_review와 같은 기준을 다시 적용한다. merge-log.md에 적힌 바뀌거나 새로 들어오거나 옮긴 사진·묶음을 먼저 보고,
      지운 문장 때문에 짝을 잃은 사진이 없는지 원고 전체를 확인한다.
${imageReviewChecks}
      공개용 사본은 final_layout에서 다시 만들므로 여기서는 계획만 보고, 실제 가림 결과는 final_layout과 visual_review가 확인한다.
      대상 파일은 고치지 않는다. 원본 탐색 범위·채택/탈락 근거·크롭 판단은 reviews/final-image-plan-{attempt}.md에, 판정은 reviews/final-image-review-{attempt}.md에 쓴다.
    inputs: [article.markup.md, story-layout.md, evidence/media-scenes.json, evidence/story-media-plan.json, reviews/merge-log.md]
    outputs: ['reviews/final-image-review-{attempt}.md', 'reviews/final-image-plan-{attempt}.md']
    completion: [실제 이미지 파일을 열어 본 목록 기록, 바뀐 사진·묶음과 짝을 잃은 사진 확인, 다섯 검사 항목별 판정과 근거, 수정 항목 또는 통과 근거 기록]
    on: {pass: final_text_review, revise: merge}
  - id: final_text_review
    title: 머지 뒤 문안·강조 재검토
    kind: review
    instruction: >-
      merge·prune을 거친 원고에 text_review와 같은 기준(사실·주체·말투·전환과 강조)을 다시 적용한다. merge-log.md에 적힌 바뀌거나 새로 들어온 문장을 먼저 보고 전체 흐름을 처음부터 다시 읽는다.
${textReviewChecks}
      사용자 답변 원문은 최신 recall 답변(experience-answers-*.json)과 작업 폴더의 사용자 진술이다.
      사용자가 직접 쓴 구절(recall 답변·채팅 기억 원문, 로컬 가이드가 정한 사용자 확정 표현 목록)은 뜻과 말투를 바꾸라고 지적하지 않고, 오타와 줄 나눔만 고칠 항목으로 적는다.
      강조(색·굵게)를 전 문단에서 다시 판정해 빠진 문장과 과한 문장을 위치와 함께 적는다. 남은 [추정]은 필수 지적이다.
      blog-markup check의 폰 한 줄 길이 fact 줄은 끝 한두 글자가 홀로 떨어질 자리이므로 의미 단위로 나눌 곳을 적는다.
    inputs: [article.markup.md, story-layout.md, evidence/story-media-plan.json, reviews/merge-log.md]
    outputs: ['reviews/final-text-review-{attempt}.md']
    completion: [바뀐 문장과 전체 흐름의 사실·주체·말투 검토, 강조 재판정, 사용자 직접 구절의 뜻·말투 보존, 추정 0건, 맛집 글의 메뉴·가격·메뉴판 확인, 수정 항목 또는 통과 근거 기록]
    on: {pass: final_layout, revise: merge}
  - id: final_layout
    title: 마무리 화면 구성
    kind: task
    instruction: >-
      merge 뒤 바뀌거나 새로 들어온 사진·묶음과 문장에 layout과 같은 공정을 다시 적용한다.
${layoutWork}
      새로 쓰거나 옮긴 사진은 story-media-plan.json handling대로 공개용 사본(위치 메타데이터 제거·크롭·얼굴 가림·영수증 개인정보·휴대폰 화면 가림)을 만들고, 원고에서 빠진 사진의 사본이 화면에 남지 않게 한다.
      동작 GIF와 스티커처럼 로컬 가이드가 정한 화면 요소는 확정된 문안 기준으로 다시 맞춘다.
      visual_review에서 revise로 돌아오면 최신 reviews/visual-review-*.md 항목을 반영한다. 줄 끝 한두 글자가 홀로 떨어지는 줄은 문장을 의미 단위로 나눠 고치고(사용자가 직접 쓴 구절은 줄 나눔만) 다시 렌더한다.
    inputs: [article.markup.md, evidence/story-media-plan.json]
    outputs: [publishing/smarteditor-draft-layout.html, reviews/final-layout-review.md]
    completion: [바뀐 사진의 공개용 사본과 가림 적용, 화면 요소 재정렬, 실제 화면 확인과 근거 기록]
    on: {done: visual_review}
  - id: visual_review
    title: 최종 화면 검토
    kind: review
    instruction: >-
${visualReviewChecks}
      본문 줄 끝 한두 글자(요./다. 같은 어미·마침표)가 360~430px 폭에서 홀로 다음 줄로 떨어지면 권장 사항이 아니라 revise 항목이다.
      blog-markup check의 폰 한 줄 길이 fact 줄과 대조해 위치를 적는다(final_layout이 의미 단위로 나눠 고치고 다시 렌더한다).
      로컬 가이드가 업로드 전 검사(업로드 폴더 검사 등)를 정했으면 그 검사 통과도 pass 조건이다.
      대상 파일은 고치지 않는다. 외부 게시·발행은 하지 않는다.
    inputs: [publishing/smarteditor-draft-layout.html]
    outputs: ['reviews/visual-review-{attempt}.md']
    completion: [실제 화면 확인, 가림 계획 컷의 실제 가림 확인, 360~430px에서 홀로 떨어진 줄 끝 글자 0건, 업로드 전 검사 결과, 통과 또는 수정 근거 기록]
    on: {pass: $complete, revise: final_layout}
`;

export const builtinDefinitions: Record<BuiltinDefinitionName, string> = {
  blog,
  "blog-v3": blogV3,
};
