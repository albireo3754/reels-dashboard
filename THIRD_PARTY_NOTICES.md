# Third-party notices

## OpenCut Classic — SRT parser adaptation

The SRT block/timestamp parsing in `src/features/subtitle-files/model/subtitles.ts` is adapted from:

- Project: https://github.com/OpenCut-app/opencut-classic
- Revision: `cf5e79e919144200294fb9fed22a222592a0aeea`
- File: `apps/web/src/subtitles/srt.ts`
- Copyright 2025–2026 OpenCut
- License: MIT; complete notice in `public/licenses/opencut-MIT.txt` (also copied into the web/app build).

This application adds stricter all-or-nothing validation, app caption constraints, basic plain-text WebVTT handling and SRT serialization. It does not include OpenCut's editor, Rust core or cloud services. The independent `ishandutta2007/open-capcut` implementation is not included.

Bundled media runtime component notices remain in the generated runtime's license directory; see `docs/editor-engine.md`. This notice does not replace those licenses.

## Development terminals

The desktop development workspace uses xterm.js 6.0.0, @xterm/addon-fit 0.11.0 and node-pty 1.1.0 (MIT). Full notices are included in `public/licenses/xterm-MIT.txt`, `public/licenses/xterm-addon-fit-MIT.txt` and `public/licenses/node-pty-MIT.txt`, copied into the web/app build. Workdesk was an architectural reference; no Workdesk source files were copied.
