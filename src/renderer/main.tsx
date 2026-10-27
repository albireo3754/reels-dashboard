import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createDemoBridge } from "../shared/demo";
import { createWebBridge } from "../shared/web";
import "./styles.css";
const bridge =
  window.reels ??
  (new URLSearchParams(location.search).get("demo") === "1"
    ? createDemoBridge()
    : createWebBridge());
createRoot(document.getElementById("root")!).render(<App bridge={bridge} />);
