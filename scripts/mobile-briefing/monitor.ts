import type { Dashboard } from "../../src/shared/contracts";
import { mobileMonitor } from "../../src/shared/mobile-monitor";
import { PlanningStore } from "../../src/shared/lib/planning-store";
import { AutopilotStore, processAlive, processStartTime } from "../../src/shared/lib/autopilot-store";
import { finishedBlogsFromServer } from "../../src/app/workflow/client";
export async function readMonitor(dashboard: Dashboard, root: string) {
  const store = new AutopilotStore(root);
  const [planning, state, config, finishedBlogs] = await Promise.all([new PlanningStore(root).get(), store.readState(), store.readConfig(), finishedBlogsFromServer()]);
  return mobileMonitor(dashboard, planning, state, config, new Date(), { isAlive: processAlive, startedAt: processStartTime }, { finishedBlogs });
}
