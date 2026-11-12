import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { workflowDefinitionSchema } from "../src/shared/workflow-definition";
// Structural schema for YAML editor support; graph semantics are validated by the runtime.
await writeFile(
  "schemas/workflow-definition.schema.json",
  JSON.stringify(z.toJSONSchema(workflowDefinitionSchema), null, 2) + "\n",
);
