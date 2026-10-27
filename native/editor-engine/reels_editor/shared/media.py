"""영상 정보 조회와 영상/이미지 프레임 읽기. 브랜드·배치 결정은 하지 않는다."""
import json
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageOps

STILL_IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp'}

def probe_video(path):
    data = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'format=duration:stream=width,height,pix_fmt,color_space,color_transfer,color_primaries,color_range:stream_tags=rotate:stream_side_data',
        '-of', 'json', str(path)]))
    stream = data['streams'][0]
    width, height = stream['width'], stream['height']
    rotation = next((item['rotation'] for item in stream.get('side_data_list', []) if 'rotation' in item),
                    int(stream.get('tags', {}).get('rotate', 0)))
    if abs(rotation) % 180 == 90:
        width, height = height, width
    duration = data['format'].get('duration')
    return stream, (width, height), float(duration) if duration is not None else None

def extract_frame(video: Path, t: float) -> Image.Image:
    if video.suffix.lower() in STILL_IMAGE_SUFFIXES:
        with Image.open(video) as image:
            return ImageOps.exif_transpose(image).convert('RGBA')
    with tempfile.TemporaryDirectory() as tmp:
        frame = Path(tmp) / "frame.png"
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", str(t), "-i", str(video),
             "-frames:v", "1", str(frame)],
            check=True)
        if not frame.is_file():
            raise ValueError(f'{t:g}초에서 프레임을 읽지 못했습니다. 영상 길이와 --t를 확인하세요')
        with Image.open(frame) as image:
            return image.convert("RGBA")

def run_ffmpeg_progress(command, duration, callback):
    """Run FFmpeg in the caller's process group and report machine progress."""
    command = [command[0], '-progress', 'pipe:1', '-nostats', *command[1:]]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, text=True)
    try:
        for line in process.stdout:
            key, _, value = line.strip().partition('=')
            if key == 'out_time_us':
                try:
                    seconds = int(value) / 1_000_000
                except ValueError:
                    continue
                callback(min(99.9, max(0, seconds / duration * 100)), seconds)
        code = process.wait()
        if code:
            raise subprocess.CalledProcessError(code, command)
        callback(100.0, duration)
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait()

__all__ = [
    'probe_video',
    'extract_frame',
    'STILL_IMAGE_SUFFIXES',
    'run_ffmpeg_progress',
]
