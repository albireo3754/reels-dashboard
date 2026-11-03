/** Passed to the renderer so it can mark an unpackaged (source/dev) build. */
export const DEV_BUILD_ARGUMENT = "--reels-dev-build";
export const APP_NAME = "Reels Dashboard";

/**
 * A source build (`npm start`, Electron not packaged) is labelled "Dev" so it
 * cannot be confused with the installed app running at the same time.
 */
export function appDisplayName(packaged: boolean): string {
  return packaged ? APP_NAME : `${APP_NAME} Dev`;
}
