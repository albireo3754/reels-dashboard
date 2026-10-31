import {
  templateContent,
  type Card,
  type CardPlan,
} from "../../../shared/card-news";
import presets from "../../../shared/card-template-presets.json";

// Browser-only practice preview. Desktop preview and export use the same native template renderer.
export async function drawCard(
  card: Card,
  style: CardPlan["style"],
  imageURL?: string,
  video = false,
): Promise<string> {
  const content = templateContent(card);
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1920;
  const ctx = canvas.getContext("2d")!;
  if (!video) {
    ctx.fillStyle = "#172e2b";
    ctx.fillRect(0, 0, 1080, 1920);
  }
  if (imageURL && !video) {
    const image = new Image();
    image.src = imageURL;
    await image.decode();
    const scale = Math.max(1080 / image.width, 1920 / image.height);
    ctx.drawImage(
      image,
      (1080 - image.width * scale) / 2,
      (1920 - image.height * scale) / 2,
      image.width * scale,
      image.height * scale,
    );
  }
  ctx.fillStyle = `rgba(5,10,17,${style.darkness})`;
  ctx.fillRect(0, 0, 1080, 1920);
  const p = presets.templates[content.templateId];
  const line = (
    text: string,
    x: number,
    y: number,
    size: number,
    color = "#fffaf5",
    width = 928,
  ) => {
    ctx.font = `700 ${size}px "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
    ctx.textBaseline = "top";
    if (ctx.measureText(text).width > width || y + size > 1780)
      throw new Error("문구가 템플릿을 넘어요. 문구나 줄바꿈을 조정해주세요.");
    ctx.fillStyle = color;
    ctx.fillText(text, x, y + ctx.measureText(text).actualBoundingBoxAscent);
  };
  let y = p.top;
  let textBottom = p.top;
  content.text.split("\n").forEach((text, i, all) => {
    line(text, 76, y, p.size, i === all.length - 1 ? "#ffb1c7" : "#fffaf5");
    const box = ctx.measureText(text);
    textBottom = y + box.actualBoundingBoxAscent + box.actualBoundingBoxDescent;
    y += Math.round(p.size * presets.lineHeight);
  });
  let notesTop = textBottom + presets.bodyNotesGap;
  if (content.templateId === "comparison" && content.table) {
    const cfg = presets.comparisonLayout;
    const tableTop = textBottom + cfg.titleGap;
    const bottom =
      tableTop +
      cfg.headerHeight +
      content.table.rows.length * cfg.rowHeight +
      cfg.padding;
    notesTop = bottom + cfg.notesGap;
    ctx.fillStyle = "#fffdf9";
    ctx.fillRect(76, tableTop, 928, bottom - tableTop);
    content.table.columns.forEach((v, j) =>
      line(
        v,
        [106, 425, 735][j],
        tableTop + cfg.padding,
        presets.roles.tableHeader,
        "#29333d",
        [290, 260, 240][j],
      ),
    );
    content.table.rows.forEach((row, i) =>
      row.forEach((v, j) =>
        line(
          v,
          [106, 425, 735][j],
          tableTop + cfg.headerHeight + i * cfg.rowHeight,
          presets.roles.tableBody,
          j === 2 ? "#b1335d" : "#29333d",
          [290, 260, 240][j],
        ),
      ),
    );
  }
  if (content.templateId === "follow") {
    if (content.signature) line(content.signature, 76, 470, p.size, "#ffb1c7");
    line("팔로우해 주세요!", 76, 690, p.size);
  }
  content.notes
    ?.split("\n")
    .forEach((v, i) =>
      line(v, 76, notesTop + i * 46, presets.roles.notes, "#d6d9df", 928),
    );
  return canvas.toDataURL("image/png");
}
