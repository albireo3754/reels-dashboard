import { useCallback, useEffect, useRef, useState } from "react";
import type { Monitor, Progress } from "../../lib/monitor";
import type { RouteMapData } from "../../lib/route-map";
import type { PublishingCopy } from "../../lib/contracts";
export type Content = Progress & {
  id: string;
  title: string;
  date: string;
  date_basis: string;
  stage: string;
  next_action: string;
  public_url: string;
  publishing_copy?: PublishingCopy | null;
  route_map?: RouteMapData | null;
  route_map_status?: "ready" | "unavailable" | null;
};
export type Asset = {
  id: string;
  content_id: string;
  role: string;
  label: string;
  file_name: string;
  mime_type: string;
  bytes: number;
  is_directory: number;
  available: number;
  item_count: number | null;
};
type BriefingData = {
  monitor?: Monitor | null;
  source: { label: string; lastSeen: string; sourceUpdatedAt: string } | null;
  online: boolean;
  mediaEnabled: boolean;
  previewsEnabled?: boolean;
  syncedAt: string | null;
  contents: Content[];
  assets: Asset[];
};

export function useBriefingSync(onAccessLost: () => void) {
  const [data, setData] = useState<BriefingData | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(true),
    [checkedAt, setCheckedAt] = useState<string | null>(null),
    [authRequired, setAuthRequired] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    if (!navigator.onLine) {
      setConnected(false);
      setError("인터넷 연결이 끊겼어요. 연결되면 다시 불러올게요.");
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const r = await fetch("/api/briefing", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (r.status === 401 || r.status === 403 || r.redirected) {
        if (pending.current !== controller) return;
        setData(null);
        onAccessLost();
        setAuthRequired(true);
        throw new Error("로그인을 다시 확인해주세요.");
      }
      if (!r.ok)
        throw new Error(
          "진행 정보를 불러오지 못했어요. 잠시 후 다시 확인해주세요.",
        );
      const next = (await r.json()) as BriefingData;
      if (pending.current !== controller) return;
      setData(next);
      setCheckedAt(new Date().toISOString());
      setConnected(true);
      setAuthRequired(false);
      setError("");
    } catch (e) {
      if (pending.current === controller)
        setError(
          controller.signal.aborted
            ? "응답이 늦어지고 있어요. 연결을 확인하고 다시 시도해주세요."
            : String(e instanceof Error ? e.message : e),
        );
    } finally {
      clearTimeout(timeout);
      if (pending.current === controller) {
        pending.current = null;
        setLoading(false);
      }
    }
  }, [onAccessLost]);
  useEffect(() => {
    setConnected(navigator.onLine);
    void refresh();
    const online = () => {
      setConnected(true);
      void refresh();
    };
    const offline = () => {
      pending.current?.abort();
      pending.current = null;
      setLoading(false);
      setConnected(false);
      setError("인터넷 연결이 끊겼어요. 연결되면 다시 불러올게요.");
    };
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = setInterval(visible, 30000);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    window.addEventListener("pageshow", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      pending.current?.abort();
      pending.current = null;
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      window.removeEventListener("pageshow", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  return { data, error, loading, connected, checkedAt, authRequired, refresh };
}
