import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
export async function makeCanonicalFixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "canonical-blog-")),
  );
  const layers = path.join(root, "layers");
  await mkdir(layers);
  const media = path.join(root, "media");
  await mkdir(media);
  const canon = path.join(root, "canonical.md"),
    layout = path.join(root, "layout.html");
  const raw =
    "---\nstatus: draft\n---\n\n### 제목\n\n산책 기록\n\n### 본문\n\n〔사진: photo.svg〕\n\n벤치에서 ==잠시== 쉬었어요\n바람이 좋았어요\n\n#### 다음 장면\n\n차를 **마셨어요**\n\n### 비공개 구성·서식\n\n개인 기록 보존\n";
  await writeFile(canon, raw);
  await writeFile(
    layout,
    '<html><style>p{line-height:1.8}</style><h1>산책 기록</h1><article><figure><img src="media/photo.svg"></figure><p class="paragraph">벤치에서 <span style="background-color:rgb(255,248,178)">잠시</span> 쉬었어요<br>바람이 좋았어요</p><h2>다음 장면</h2><p class="paragraph">차를 <strong>마셨어요</strong></p></article></html>',
  );
  await writeFile(
    path.join(media, "photo.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#d8e6d9"/><path d="M80 300L300 80 530 300" stroke="#678b72" fill="none" stroke-width="16"/></svg>',
  );
  const G = {
    layout: [
      { photo: "photo.svg", alt: "산책 풍경" },
      { text: "T1" },
      { heading: "다음 장면" },
      { text: "T2" },
    ],
  };
  const B = {
    bundles: [
      {
        id: "G1",
        name: "산책",
        question: "어디에서 쉬었나?",
        from: "photo:photo.svg",
        to: "T1",
      },
      {
        id: "G2",
        name: "찻집",
        question: "무엇을 마셨나?",
        from: "heading:다음 장면",
        to: "T2",
      },
    ],
  };
  await writeFile(path.join(layers, "grouping-layer.json"), JSON.stringify(G));
  await writeFile(path.join(layers, "bundle-layer.json"), JSON.stringify(B));
  await writeFile(
    path.join(layers, "emphasis-layer.json"),
    JSON.stringify({
      emphasis: [
        {
          id: "T1",
          phrase: "잠시",
          style: { bg: "rgb(255,248,178)" },
          role: "잠깐 쉼",
        },
        { id: "T2", phrase: "마셨어요", style: { weight: 700 } },
      ],
    }),
  );
  return { root, raw, config: { canon, layers, media, layout, port: 0 } };
}
