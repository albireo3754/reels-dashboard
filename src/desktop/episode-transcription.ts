import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { localRuntime, runLocalWhisper } from "./call-shorts-local-stt";

export const episodeFiles = ["transcript.json", "words.json", "transcript.md"] as const;

export function episodeWorkDir(source: string) {
  const dir = path.dirname(source);
  return path.basename(dir) === "source" && /^EP\d+$/i.test(path.basename(path.dirname(dir)))
    ? path.join(path.dirname(dir), "work") : undefined;
}

// Keep one complete, immutable-by-the-importer set per source version. Publish the
// canonical work/ names without replacing earlier transcripts or human edits.
const worker = String.raw`
import datetime, hashlib, json, os, pathlib, sys, tempfile
from mlx_whisper import transcribe

model, source, output = sys.argv[1:]
src, work = pathlib.Path(source), pathlib.Path(output)
os.umask(0o077)
def identity():
    st = src.stat()
    return [source, st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns]
initial = identity()
key = hashlib.sha256(json.dumps(initial).encode()).hexdigest()[:24]
if work.is_symlink(): sys.exit(4)
work.mkdir(exist_ok=True)
cache = work / "원본전사"
cache.mkdir(exist_ok=True)
target = cache / key
if any(p.is_symlink() for p in (work, cache, target)):
    sys.exit(4)
names = ["transcript.json", "words.json", "transcript.md"]
reused = target.is_dir()
if not reused:
    data = transcribe(source, path_or_hf_repo=model, language="ko",
                      condition_on_previous_text=False, word_timestamps=True, verbose=None)
    words = [{"word": w["word"], "start": round(w["start"],3), "end": round(w["end"],3),
              "p": round(w.get("probability",0),3)}
             for s in data["segments"] for w in s.get("words",[])]
    if not words:
        sys.exit(3)
    if initial != identity():
        sys.exit(5)
    with tempfile.TemporaryDirectory(dir=cache, prefix=".stt-") as tmp:
        bundle = pathlib.Path(tmp) / "result"
        bundle.mkdir()
        for name, value in zip(names, [data, words]):
            (bundle / name).write_text(json.dumps(value, ensure_ascii=False, indent=1, allow_nan=False), encoding="utf8")
        lines = ["# 원본 시간대별 대본", "", "자동 전사 · 사람 확인 전", ""]
        for s in data["segments"]:
            if s["text"].strip():
                stamp = str(datetime.timedelta(seconds=int(s["start"])))
                lines.append(f'[{stamp}] {s["text"].strip()}')
        (bundle / names[2]).write_text("\n".join(lines) + "\n", encoding="utf8")
        bundle.rename(target)
if not all((target/n).is_file() and not (target/n).is_symlink() and (target/n).stat().st_size for n in names):
    sys.exit(4)
def own(name):
    dest = work / name
    return not dest.is_symlink() and dest.is_file() and dest.samefile(target / name)
canonical = all(not os.path.lexists(work/n) or own(n) for n in names)
if canonical:
    created = []
    try:
        for n in names:
            if not own(n):
                os.link(target/n, work/n)
                created.append(n)
    except FileExistsError:
        for n in created:
            if own(n): (work/n).unlink()
        canonical = False
print(json.dumps({"directory":str(work if canonical else target), "reused":reused, "cache":str(target)}))
`;

export async function transcribeEpisode(source: string, directory: string): Promise<{directory: string; reused: boolean; cache: string}> {
  if (await realpath(source) !== source || !(await stat(source)).isFile()) throw new Error("원본 영상을 다시 연결해 주세요.");
  if (await realpath(path.dirname(directory)) !== path.dirname(directory)) throw new Error("작업 폴더의 실제 위치를 선택해 주세요.");
  const { python, model } = await localRuntime();
  try {
    const { stdout } = await runLocalWhisper(python, model, worker, [source, directory]);
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 3) throw new Error("원본에서 전사할 말을 찾지 못했어요.");
    if (code === 4) throw new Error("전사 결과 경로를 확인해 주세요. 기존 파일은 보존했어요.");
    if (code === 5) throw new Error("전사 중 원본이 바뀌었어요. 파일 저장이 끝나면 다시 시도해 주세요.");
    throw new Error("원본 전사를 완료하지 못했어요. 오디오 트랙과 Mac의 로컬 전사 환경을 확인해 주세요.");
  }
}
