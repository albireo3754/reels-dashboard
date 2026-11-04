import "../shared/ui/tokens.css";
import "../shared/ui/components.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ShortcutsProvider } from "../shared/ui/shortcuts";
import {CanonicalBlogEditor} from "../features/canonical-blog";
import { createDemoBridge } from "../shared/demo";
import { createWebBridge } from "../shared/web";
import { emptyDashboard } from "../shared/contracts";
import "./styles.css";
const bridge =
  window.reels ??
  (new URLSearchParams(location.search).get("demo") === "1"
    ? createDemoBridge()
    : createWebBridge());
// The local workflow server has its own persisted runs; it does not need a shared desktop snapshot.
if (!window.reels && new URLSearchParams(location.search).has("workflow")) {
  bridge.loadDashboard = async () => emptyDashboard();
}
createRoot(document.getElementById("root")!).render(new URLSearchParams(location.search).has("blogEditor") ? <CanonicalBlogEditor/> : <ShortcutsProvider host={bridge.workbench}><App bridge={bridge} /></ShortcutsProvider>);
