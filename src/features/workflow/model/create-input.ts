/** The `/create` request body for the new-workflow form. */
export function createRunInput(
  form: FormData,
  {
    usesDefinition,
    builtinDefinition,
    definitionFile,
  }: {
    usesDefinition: boolean;
    builtinDefinition: string;
    definitionFile: string;
  },
) {
  return {
    title: form.get("title"),
    workspace: form.get("workspace"),
    instructions: form.get("instructions"),
    trackedFiles: String(form.get("files"))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    maxRevisions: Number(form.get("maxRevisions")),
    collectExperience: !usesDefinition && form.get("experience") === "on",
    ...(usesDefinition
      ? {
          ...(builtinDefinition ? { builtinDefinition } : { definitionFile }),
          ...(form.get("guideFile")
            ? { guideFile: form.get("guideFile") }
            : {}),
          skipCompleted: form.get("skipCompleted") === "on",
        }
      : {}),
    ...(form.get("projectId") ? { projectId: form.get("projectId") } : {}),
  };
}
