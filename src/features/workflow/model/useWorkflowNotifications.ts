import { useEffect, useState } from "react";

/** Switching the app tab keeps mounted editor drafts intact. The panel selects the run. */
export function useWorkflowNotifications(navigate: (tab: "workflow") => void) {
  const [request, setRequest] = useState<{ runId: string; sequence: number }>();
  useEffect(
    () =>
      window.reels?.workflow?.onOpen?.((id) => {
        setRequest((previous) => ({
          runId: id,
          sequence: (previous?.sequence ?? 0) + 1,
        }));
        navigate("workflow");
      }),
    [navigate],
  );
  return request;
}
