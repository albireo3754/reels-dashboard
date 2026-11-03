// Injected into the CJS desktop main bundle (see build-desktop.mjs): stands in for
// import.meta.url, which is empty in CommonJS output.
import { pathToFileURL } from "node:url";
export const __reelsImportMetaUrl = pathToFileURL(__filename).href;
