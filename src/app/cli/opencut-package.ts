import path from "node:path";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  ContentLibrary,
  prepareLocalMedia,
} from "../../features/content-library";
import {
  buildOpenCutProject,
  openCutPackageSchema,
  openCutTemplates,
  type OpenCutRecipe,
} from "../../features/opencut-template";
import { contentInputSchema } from "../../shared/local-resources";
import { LocalStore } from "../../shared/lib/storage";
import { callAgent } from "../../shared/lib/agent-socket";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const stamp = (seconds: number) => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};

export function openCutApplyScript(recipe: OpenCutRecipe) {
  // This is a Playwright function for an explicitly chosen, seeded editor project.
  // The browser still owns actual media IDs and checks their duration before any write.
  return `async (page) => {
    const id = new URL(page.url()).searchParams.get('project');
    if (!id || new URL(page.url()).origin !== 'https://opencut.app') throw Error('Open the target OpenCut editor first.');
    await page.goto('https://opencut.app/projects');
    const result = await page.evaluate(async ({id,recipe,style}) => {
      const open = n => new Promise((ok,no) => {const q=indexedDB.open(n);q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error)});
      const db=await open('video-editor-projects');
      const seed=await new Promise((ok,no)=>{const q=db.transaction('projects').objectStore('projects').get(id);q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error)});
      if(!seed)throw Error('Target project missing');
      const mdb=await open('video-editor-media-'+id);
      const media=await new Promise((ok,no)=>{const q=mdb.transaction('media-metadata').objectStore('media-metadata').getAll();q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error)});
      const build=${buildOpenCutProject.toString()};
      const project=build(seed,media,recipe,style);
      await new Promise((ok,no)=>{const tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(project);tx.oncomplete=ok;tx.onerror=()=>no(tx.error)});
      delete seed.metadata.thumbnail; delete project.metadata.thumbnail;
      return {before:seed,project,media:media.map(m=>({id:m.id,name:m.name,type:m.type,duration:m.duration}))};
    }, {id,recipe:${JSON.stringify(recipe)},style:${JSON.stringify(openCutTemplates[recipe.templateId])}});
    await page.goto('https://opencut.app/editor?project='+id);
    return result;
  }`;
}

/** Existing Dashboard API registers the package; no direct dashboard.json mutation. */
export async function prepareOpenCutPackage(
  value: unknown,
  root: string,
  call: (name: string, args: unknown) => Promise<any> = (name, args) =>
    callAgent(root, name, args),
) {
  const input = openCutPackageSchema.parse(value);
  const template = openCutTemplates[input.recipe.templateId];
  const library = new ContentLibrary(new LocalStore(root));
  const blog = await library.documentText(input.projectId, input.blogPath);
  if (blog.truncated)
    throw new Error("블로그 원고가 너무 커요. 원고를 분리해주세요.");
  const files = input.sources.map((f) => path.basename(f));
  if (input.recipe.cuts.some((c) => !files.includes(c.file)))
    throw new Error("컷의 파일이 sources에 없어요.");
  // Ensure the live app can register before copying potentially large media.
  await call("reels_get_content", { projectId: input.projectId });
  const copied = await prepareLocalMedia(library, {
    projectId: input.projectId,
    sources: input.sources,
    destination: input.destination,
  });
  const write = (name: string, text: string) =>
    writeFile(path.join(input.destination, name), text, {
      flag: "wx",
      mode: 0o600,
    });
  const duration = input.recipe.cuts.reduce((t, c) => t + c.length, 0);
  await write("recipe.json", JSON.stringify(input.recipe, null, 2));
  await write("template.json", JSON.stringify(template, null, 2));
  await write("apply-opencut.js", openCutApplyScript(input.recipe));
  await write(
    "captions.srt",
    input.recipe.captions
      .map(
        (c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}`,
      )
      .join("\n\n") + "\n",
  );
  await write(
    "manifest.json",
    JSON.stringify(
      {
        projectId: input.projectId,
        blogPath: input.blogPath,
        blogSha256: digest(blog.text),
        templateId: input.recipe.templateId,
        duration,
        mediaReceipt: copied.receiptPath,
        state: "prepared",
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  await write(
    "README.md",
    `# ${input.recipe.place} — OpenCut 자막 소개\n\n` +
      `상태: 편집 패키지 준비. 영상 출력·게시 완료가 아닙니다.\n\n` +
      `블로그: ${input.blogPath}\n\n` +
      `1. OpenCut에서 이 소재의 프로젝트를 열고 이 폴더의 촬영본을 가져옵니다. 중복으로 가져오지 않습니다.\n` +
      `2. 처음 만든 프로젝트에는 영상·사진(사용할 때만)·기본 텍스트를 하나씩 타임라인에 넣습니다.\n` +
      `3. 기존 프로젝트를 고칠 때는 먼저 백업합니다. 편집기에서 apply-opencut.js를 Playwright로 실행합니다. 대상은 현재 열린 프로젝트입니다.\n` +
      `4. 반환된 before와 project를 로컬에 저장합니다. 먼저 짧게 출력해 배치·색을 확인합니다.\n` +
      `5. 전체 MP4와 무자막 기본본을 무음으로 출력하고 같은 Dashboard 프로젝트에 연결합니다.\n\n` +
      `예상 ${duration.toFixed(2)}초 · 정지사진 최대3초 · 나레이션 없음 · 1080×1920/30fps.\n\n` +
      `recipe.json의 문안·컷은 에이전트가 촬영본과 블로그를 읽고 선정한 입력입니다. 블로그를 자동 요약하거나 새 경험을 생성하는 기능은 아닙니다. OpenCut 공식 import 파일이 아닙니다.\n`,
  );
  const currentBlog = await library.documentText(
    input.projectId,
    input.blogPath,
  );
  if (currentBlog.truncated || digest(currentBlog.text) !== digest(blog.text))
    throw new Error(
      "원고가 준비 중 바뀌었어요. 생성 폴더를 확인하고 새 원고로 다시 준비해주세요.",
    );
  const current = await call("reels_get_content", {
    projectId: input.projectId,
  });
  const p = current.project;
  const content = contentInputSchema.parse({
    id: p.id,
    title: p.title,
    date: p.date,
    dateBasis: p.dateBasis,
    stage: p.stage,
    nextAction: p.nextAction,
    publicURL: p.publicURL,
    localNotes: p.localNotes,
    resources: [
      ...p.resources,
      {
        role: "folder",
        path: input.destination,
        label: `OpenCut ${template.name} · 편집 패키지`,
      },
      {
        role: "document",
        path: path.join(input.destination, "README.md"),
        label: "OpenCut 템플릿 사용법",
      },
      {
        role: "document",
        path: path.join(input.destination, "recipe.json"),
        label: "OpenCut 컷·자막 입력",
      },
    ],
    ...(p.publications ? { publications: p.publications } : {}),
  });
  const registered = await call("reels_upsert_content", {
    content,
    expectedUpdatedAt: current.updatedAt,
  });
  const check = await call("reels_get_content", { projectId: input.projectId });
  if (
    !check.project.resources.some(
      (r: { path: string }) => r.path === input.destination,
    )
  )
    throw new Error(
      "등록 결과를 확인하지 못했어요. 다시 쓰기 전에 프로젝트를 조회해주세요.",
    );
  return {
    projectId: input.projectId,
    directory: input.destination,
    duration,
    registered: true,
    updatedAt: registered.updatedAt,
  };
}
