// Reuse Dashboard's project/resource grants without restarting the active app.
import { readFile } from "node:fs/promises";
import { LocalStore } from "../src/shared/lib/storage";
import { ContentLibrary, prepareLocalMedia } from "../src/features/content-library";

const [root, projectId, selection, destination] = process.argv.slice(2);
if (!root || !projectId || !selection || !destination || process.argv.length !== 6)
  throw new Error("Usage: node --import tsx scripts/prepare-local-media.ts USER_DATA PROJECT_ID SELECTION.json NEW_DESTINATION");
const sources: unknown = JSON.parse(await readFile(selection, "utf8"));
if (!Array.isArray(sources) || sources.some(file => typeof file !== "string"))
  throw new Error("SELECTION.json must be an array of registered absolute media paths.");
const library = new ContentLibrary(new LocalStore(root));
console.log(JSON.stringify(await prepareLocalMedia(library, { projectId, sources, destination }), null, 2));
