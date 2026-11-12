import { useEffect, useState } from "react";
import type { DashboardBridge, TerminalSetting } from "../shared/contracts";
import {
  Button,
  Notice,
  Section,
  SectionHeader,
  StatusText,
} from "../shared/ui/primitives";

/** 설정 화면의 터미널 토글. 이 Mac에만 저장하고 다음 실행부터 적용한다. */
export function TerminalSettingPanel({ bridge }: { bridge: DashboardBridge }) {
  const [setting, setSetting] = useState<TerminalSetting>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    bridge.terminalSetting
      ?.get()
      .then((value) => live && setSetting(value))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [bridge]);
  if (!bridge.terminalSetting) return null;
  const api = bridge.terminalSetting;
  const wanted = !!setting && (setting.enabled || setting.forcedByEnvironment);
  const pending = !!setting && wanted !== setting.active;
  const act = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section divided className="settings-section">
      <SectionHeader
        title="터미널"
        description="상단 툴바의 터미널과 ⌘N 하단 패널에서 Codex·셸 세션을 써요. 앱 소스 폴더에서 명령을 실행하니 필요할 때만 켜주세요. 앱을 다시 시작하면 적용돼요."
      />
      <label className="ui-check">
        <input
          type="checkbox"
          aria-label="터미널 사용"
          checked={!!setting?.enabled}
          disabled={!setting || busy}
          onChange={(e) => {
            const enabled = e.target.checked;
            void act(async () => setSetting(await api.set(enabled)));
          }}
        />
        터미널 사용
      </label>
      {setting?.forcedByEnvironment && (
        <p className="ui-meta">
          REELS_DEV_MODE=1로 실행해서 이 설정과 관계없이 켜져 있어요.
        </p>
      )}
      {pending && (
        <div className="button-row">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void act(() => api.relaunch())}
          >
            지금 다시 시작
          </Button>
        </div>
      )}
      {error ? (
        <Notice tone="danger">{error}</Notice>
      ) : (
        <StatusText live busy={busy}>
          {pending
            ? wanted
              ? "다시 시작하면 터미널이 켜져요."
              : "다시 시작하면 터미널이 꺼져요."
            : ""}
        </StatusText>
      )}
    </Section>
  );
}
