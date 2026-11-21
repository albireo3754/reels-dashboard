/**
 * Step 3 — 캐릭터 시트 고정 → 컷별 손그림 일러스트.
 *
 * 캐릭터 시트를 먼저 만들고 사람이 한 세트를 고정합니다. 이후 모든 컷이 그 시트를 참조합니다.
 * AI 티 제거: 네거티브 + 후처리(그레인·회전·채도·검정 #1A1A1A).
 * 실사화 금지: 실제 인물로 알아볼 수 있게 그리는 변형을 만들지 않습니다(가드레일 5).
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { BudgetGuard } from "./budget.js";
import type { Config } from "./config.js";
import { NeedsHumanError, PipelineError } from "./errors.js";
import { requireFfmpeg, run } from "./media.js";
import { createImageModel, type ImageModel } from "./providers.js";
import type { StateStore } from "./state.js";
import type { Episode } from "./types.js";

const MAX_RETRIES = 2;

export const CHARACTER_SHEET_PROMPT = `Create a CHARACTER SHEET for a Korean couple's comedy shorts, drawn in a deliberately
sloppy hand-drawn marker style (B-grade doodle, not polished).

STYLE LOCK
- thick black felt-tip marker lines, wobbly and uneven, varying pressure
- flat color fills that slightly overflow the outlines, marker bleed at edges
- off-white paper background with subtle paper grain
- palette: black line + pastel pink (#FF6B9D) for the girl's accents,
  sky blue (#4FC3F7) for the boy's accents ONLY
- childlike proportions, oversized head (1:2.5), dot eyes, single-line mouth,
  noodle arms, no realistic anatomy, no shading gradients
- looks like someone doodled it on a tablet in five minutes

SUBJECTS
- GIRL: short bob hair, one hair clip, oversized hoodie, sleepy eyes, expressive eyebrows
- BOY: messy short hair, round glasses (simple circles), t-shirt

LAYOUT
One image, 3x2 grid on plain paper: girl neutral / girl annoyed / girl serious,
boy neutral / boy confused / boy smug.

HARD NO
photorealistic, 3D, glossy, gradient background, clean vector lines, perfect
symmetry, anime rendering, detailed eyes, realistic hands, extra fingers,
signature, watermark, logo, identifiable real person`;

export const CUT_PROMPT = `Using the attached images:
- image 1: the GIRL character (identity reference)
- image 2: the BOY character (identity reference)
- image 3: line & color style reference
Draw ONE new scene, 9:16 vertical, in exactly that style. Keep both characters
immediately recognizable from the references.

STYLE (must match reference 3)
sloppy thick marker lines, uneven pressure, flat fills overflowing the lines,
off-white paper with grain, single accent color per character as in the sheet,
generous white space, no gradients, no shading, no 3D.

SCENE
{scene}
CHARACTER ACTION
{action}
EMOTION
{emotion}
PROPS
{props}

COMPOSITION
- subject occupies the middle 60% vertically, top 25% left empty for the hook caption
- bottom 18% left empty for subtitles
- camera feels hand-placed: slight tilt, not centered

DO NOT include any speech bubbles or text — captions are added in post.
DO NOT make them look like identifiable real people.

Hard negative prompt: photorealistic, 3D render, CGI, glossy shading, specular
highlights, gradient background, airbrush, cinematic lighting, depth of field,
bokeh, vector art, clean uniform outlines, perfect symmetry, polished digital
illustration, masterpiece, 8k, highly detailed, realistic skin texture, detailed
eyes, anatomically correct hands, extra fingers, deformed face, watermark, logo,
signature, QR code, text, letters`;

export interface IllustrationResult {
  cuts: string[];
  characterSheets: Record<string, string>;
  costUsd: number;
}

export class Illustrator {
  private readonly config: Config;
  private readonly model: ImageModel;
  private readonly guard?: BudgetGuard;

  constructor(config: Config, store?: StateStore, model?: ImageModel) {
    this.config = config;
    this.model = model ?? createImageModel(config);
    this.guard = store ? new BudgetGuard(config, store) : undefined;
  }

  async ensureCharacterSheets(projectDir: string): Promise<Record<string, string>> {
    const imagesDir = path.join(projectDir, "images");
    const refsDir = path.join(imagesDir, "refs");
    mkdirSync(refsDir, { recursive: true });

    const roles = ["girl", "boy", "style"] as const;
    const fixed = Object.fromEntries(
      roles.map((role) => [role, path.join(this.config.characterSheetDir, `char_sheet_${role}.png`)]),
    ) as Record<(typeof roles)[number], string>;

    if (existsSync(fixed.girl) && existsSync(fixed.boy)) {
      const copied: Record<string, string> = {};
      for (const role of roles) {
        if (!existsSync(fixed[role])) continue;
        const target = path.join(refsDir, `char_sheet_${role}.png`);
        copyFileSync(fixed[role], target);
        copied[role] = target;
      }
      return copied;
    }

    const existing: Record<string, string> = {};
    const haveAll = roles.every((role) => existsSync(path.join(refsDir, `char_sheet_${role}.png`)));
    if (haveAll) {
      for (const role of roles) existing[role] = path.join(refsDir, `char_sheet_${role}.png`);
      return existing;
    }

    const candidates: Record<string, Record<string, string>> = {};
    for (const label of ["a", "b"]) {
      candidates[label] = {};
      for (const role of roles) {
        const dest = path.join(imagesDir, `char_sheet_candidate_${label}_${role}.png`);
        this.spend(projectDir, "캐릭터 시트");
        await this.model.generate({ prompt: `${CHARACTER_SHEET_PROMPT}\n\nVARIATION: ${label.toUpperCase()}`, dest, aspectRatio: "1:1" });
        candidates[label][role] = dest;
      }
    }

    if (this.config.dryRun) {
      const chosen: Record<string, string> = {};
      for (const role of roles) {
        const target = path.join(refsDir, `char_sheet_${role}.png`);
        copyFileSync(candidates.a[role], target);
        chosen[role] = target;
      }
      return chosen;
    }

    throw new NeedsHumanError("캐릭터 시트 후보 2세트를 만들었습니다. 한 세트를 골라 주세요.", {
      hint: `images/char_sheet_candidate_a_*.png 또는 _b_*.png 를 보고, 고른 세트를 ${this.config.characterSheetDir}/char_sheet_{girl,boy,style}.png 로 복사한 뒤 다시 실행하세요.`,
      action: `npm run call-shorts -- resume --project ${projectDir} --stage illustrate`,
    });
  }

  async generate(projectDir: string, episode: Episode): Promise<IllustrationResult> {
    const imagesDir = path.join(projectDir, "images");
    mkdirSync(imagesDir, { recursive: true });
    const sheets = await this.ensureCharacterSheets(projectDir);
    const references = ["girl", "boy", "style"].map((role) => sheets[role]).filter((value): value is string => Boolean(value));
    const produced: string[] = [];
    let spent = 0;

    for (const cut of episode.cuts ?? []) {
      const idx = cut.idx ?? produced.length + 1;
      const prompt = CUT_PROMPT.replace("{scene}", cut.visual?.scene || "두 사람이 폰으로 통화하는 장면")
        .replace("{action}", cut.visual?.action || "폰을 귀에 대고 표정이 굳음")
        .replace("{emotion}", cut.visual?.emotion || "당황")
        .replace("{props}", (cut.visual?.props ?? ["스마트폰"]).join(", "));
      const dest = path.join(imagesDir, `cut_${String(idx).padStart(2, "0")}.png`);
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
          this.spend(projectDir, `컷 ${idx}`);
          await this.model.generate({ prompt, dest, references });
          if (!existsSync(dest) || statSync(dest).size === 0) throw new PipelineError(`이미지가 비었습니다: ${dest}`);
          spent += this.model.priceUsd;
          lastError = null;
          break;
        } catch (error) {
          lastError = error as Error;
          console.warn(`[illustrator] 컷 ${idx} 실패 (${attempt + 1}/${MAX_RETRIES + 1}): ${lastError.message}`);
        }
      }
      if (lastError) {
        throw new PipelineError(`컷 ${idx} 이미지를 ${MAX_RETRIES + 1}회 시도해도 만들지 못했습니다: ${lastError.message}`, {
          hint: "visual.scene 문장을 더 구체적으로 고치세요.",
        });
      }
      produced.push(dest);
    }

    const processed = this.postprocessAll(projectDir, produced);
    return { cuts: processed, characterSheets: sheets, costUsd: Number(spent.toFixed(4)) };
  }

  postprocessAll(projectDir: string, images: string[]): string[] {
    const outDir = path.join(projectDir, "images", "processed");
    mkdirSync(outDir, { recursive: true });
    let ffmpeg: string;
    try {
      ffmpeg = requireFfmpeg(this.config);
    } catch {
      return images;
    }

    return images.map((image, index) => {
      const dest = path.join(outDir, path.basename(image));
      const angle = [0.022, -0.019, 0.014, -0.023, 0.017, -0.012, 0.021][index % 7];
      const filter = [
        "scale=1188:2112:force_original_aspect_ratio=increase",
        "crop=1188:2112",
        `rotate=${angle}:ow=iw:oh=ih:fillcolor=0xFDF9F2`,
        "eq=saturation=0.92:contrast=1.03",
        "curves=all='0/0.10 1/1'",
        "noise=alls=6:allf=t+u",
      ].join(",");
      try {
        run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", image, "-vf", filter, "-frames:v", "1", dest], {
          timeoutMs: 120_000,
        });
        return dest;
      } catch {
        return image;
      }
    });
  }

  private spend(projectDir: string, note: string): void {
    const price = this.model.priceUsd;
    if (!this.guard) return;
    this.guard.checkAll(projectDir, price, true);
    if (price > 0) this.guard.record({ usd: price, provider: this.model.name, stage: "illustrate", projectDir, note });
  }
}

export function listPngs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".png"))
    .map((name) => path.join(dir, name))
    .sort();
}
