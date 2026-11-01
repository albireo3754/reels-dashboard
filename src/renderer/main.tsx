import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createDemoBridge } from "../shared/demo";
import { createWebBridge } from "../shared/web";
import { emptyDashboard } from "../shared/contracts";
import "./styles.css";
const bridge =
  window.reels ??
  (new URLSearchParams(location.search).get("demo") === "1"
    ? createDemoBridge()
    : createWebBridge());
// The local workflow server uses persisted runs, not a shared desktop snapshot.
if (!window.reels && new URLSearchParams(location.search).has("workflow")) {
  bridge.loadDashboard = async () => emptyDashboard();
}
createRoot(document.getElementById("root")!).render(<App bridge={bridge} />);
