// Main resolves the opt-in once and sends only this capability to sandboxed preload.
export const DEVELOPMENT_MODE_ARGUMENT = "--reels-dev-mode";

export function developmentModeEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.REELS_DEV_MODE === "1";
}
