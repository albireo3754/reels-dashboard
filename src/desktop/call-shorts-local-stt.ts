import { execFile } from "node:child_process";
import { access, chmod, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
type Input = { sourcePath: string; outputStem: string };
type Result = { name: string; textPath: string; subtitlePath: string };

const worker = String.raw`
import os, pathlib, sys, tempfile
from mlx_whisper import transcribe

def stamp(sec):
    ms = max(0, round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"

def save(final, text):
    with tempfile.NamedTemporaryFile(dir=final.parent, prefix=".notes-stt-", mode="w", encoding="utf-8", delete=False) as tmp:
        tmp_name = tmp.name
    try:
        with open(tmp_name, "w", encoding="utf-8") as out:
            out.write(text)
        os.link(tmp_name, final)
    finally:
        os.unlink(tmp_name)

os.umask(0o077)
model, out_dir, src, stem = sys.argv[1:]
out_dir = pathlib.Path(out_dir)
out_text, out_srt = out_dir / (stem + ".txt"), out_dir / (stem + ".srt")
if out_text.is_file() and out_srt.is_file():
    sys.exit(0)
data = transcribe(src, path_or_hf_repo=model, task="transcribe", language="ko", verbose=None, condition_on_previous_text=False)
segments = [s for s in data["segments"] if s["text"].strip()]
if not segments:
    sys.exit(3)
if not out_text.exists():
    save(out_text, "".join(f"[{stamp(s['start']).split(',')[0]}] {s['text'].strip()}\n" for s in segments))
if not out_srt.exists():
    save(out_srt, "\n".join(f"{i}\n{stamp(s['start'])} --> {stamp(s['end'])}\n{s['text'].strip()}\n" for i, s in enumerate(segments, 1)))
`;

async function available(file: string) {
  try { await access(file); return true; } catch { return false; }
}

async function hasWeights(dir: string) {
  return Boolean(dir) && path.isAbsolute(dir) && await available(path.join(dir, "config.json")) &&
    ((await available(path.join(dir, "weights.safetensors"))) || (await available(path.join(dir, "weights.npz"))));
}

async function localRuntime() {
  const home = homedir();
  const snapshots = path.join(home, ".cache", "huggingface", "hub", "models--mlx-community--whisper-large-v3-turbo", "snapshots");
  const modelCandidates = process.env.REELS_LOCAL_STT_MODEL ? [process.env.REELS_LOCAL_STT_MODEL] :
    (await readdir(snapshots, { withFileTypes: true }).catch(() => [])).filter(x => x.isDirectory()).map(x => path.join(snapshots, x.name));
  let model: string | undefined;
  for (const entry of modelCandidates) if (await hasWeights(entry)) { model = entry; break; }
  if (!model) throw new Error("맥에 저장된 로컬 전사 모델을 찾지 못했어요.");

  const cache = path.join(home, ".cache", "uv", "archive-v0");
  const explicit = process.env.REELS_LOCAL_STT_PYTHON;
  let python: string | undefined;
  if (explicit && path.isAbsolute(explicit) && await available(explicit)) python = explicit;
  if (!explicit) {
    for (const name of (await readdir(cache).catch(() => [])).sort()) {
      const folder = path.join(cache, name);
      if (await available(path.join(folder, "bin", "mlx_whisper")) && await available(path.join(folder, "bin", "python"))) {
        python = path.join(folder, "bin", "python");
        break;
      }
    }
  }
  if (!python) throw new Error("맥의 로컬 전사 실행 환경을 찾지 못했어요.");
  return { python, model };
}

/** Explicitly requested macOS-local transcription; never uses provider APIs or downloads models. */
export async function transcribeLocalCallRecordings(inputs: Input[], outputDir: string): Promise<Result[]> {
  if (process.platform !== "darwin" || !process.getuid) throw new Error("로컬 통화 전사는 Mac에서만 실행돼요.");
  if (!inputs.length || inputs.length > 2 || !path.isAbsolute(outputDir)) throw new Error("한 번에 녹음 한두 개를 선택하세요.");
  const stems = new Set<string>();
  for (const input of inputs) {
    if (!path.isAbsolute(input.sourcePath) || !/^[\p{L}\p{N}_-]{1,110}$/u.test(input.outputStem) || stems.has(input.outputStem)) {
      throw new Error("녹음 파일 대상으로 쓸 수 없어요.");
    }
    stems.add(input.outputStem);
  }
  const { python, model } = await localRuntime();
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await chmod(outputDir, 0o700);
  const results: Result[] = [];
  for (const { sourcePath, outputStem } of inputs) {
    const textPath = path.join(outputDir, `${outputStem}.txt`);
    const subtitlePath = path.join(outputDir, `${outputStem}.srt`);
    try {
      await exec("/bin/launchctl", ["asuser", String(process.getuid()), python, "-c", worker, model, outputDir, sourcePath, outputStem], {
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ""}`,
          HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", PYTHONNOUSERSITE: "1" },
        timeout: 45 * 60_000, maxBuffer: 512 * 1024,
      });
      if (!(await stat(textPath)).size || !(await stat(subtitlePath)).size) throw new Error("empty output");
    } catch (err) {
      if ((err as { code?: number }).code === 3) throw new Error("녹음에서 전사할 음성을 찾지 못했어요.");
      throw new Error("맥에서 로컬 전사를 완료하지 못했어요. 맥 사용자 세션과 전사 환경을 확인해 주세요.");
    }
    results.push({ name: outputStem, textPath, subtitlePath });
  }
  return results;
}
