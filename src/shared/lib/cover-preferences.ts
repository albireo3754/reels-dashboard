import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  coverPreferencesSchema,
  defaultCoverPreferences,
  type CoverPreferencesBridge,
} from "../clip-upload";
import { readJsonFile, writeJsonAtomic } from "./fs";

/** Local app preferences, never part of a project or shared dashboard snapshot. */
export class CoverPreferencesStore implements CoverPreferencesBridge {
  constructor(private root: string) {}
  private get file() {
    return path.join(this.root, "cover-preferences.json");
  }
  get() {
    return readJsonFile(
      this.file,
      (value) => coverPreferencesSchema.parse(value),
      () => ({ ...defaultCoverPreferences }),
    );
  }
  async set(value: unknown) {
    const input = coverPreferencesSchema.parse(value);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.file, input, { mode: 0o600 });
    return input;
  }
}
