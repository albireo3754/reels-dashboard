import type { Dispatch, ReactNode, SetStateAction } from "react";
import { CoverPreferencesPanel } from "./ClipUploadControls";
import type { Dashboard, DashboardBridge } from "../shared/contracts";
import { Section, SectionHeader } from "../shared/ui/primitives";
import { readableTime } from "./photo-export/shared";
import { TerminalSettingPanel } from "./TerminalSettingPanel";

/** 설정 화면. 상태(동기화 주소·토큰 포함)는 App이 들고 있어 탭을 오가도 유지 규칙이 같다. */
export function SettingsScreen({
  readOnly,
  connection,
  nativeNotice,
  bridge,
  dashboard,
  busy,
  run,
  setNotice,
  endpoint,
  setEndpoint,
  token,
  setToken,
}: {
  readOnly: boolean;
  connection: ReactNode;
  nativeNotice: ReactNode;
  bridge: DashboardBridge;
  dashboard: Dashboard;
  busy: string;
  run: (name: string, fn: () => Promise<void>) => Promise<void>;
  setNotice: Dispatch<SetStateAction<string>>;
  endpoint: string;
  setEndpoint: Dispatch<SetStateAction<string>>;
  token: string;
  setToken: Dispatch<SetStateAction<string>>;
}) {
  return (
    <>
      {!readOnly ? (
        <Section className="settings-section">
          <SectionHeader
            title="Photos 연결"
            description="사진 접근 권한은 앱에 포함된 도우미가 관리해요. 막혀 있으면 macOS 사진 접근 설정을 확인해주세요."
          />
          {connection}
        </Section>
      ) : (
        nativeNotice
      )}
      {!readOnly && <CoverPreferencesPanel bridge={bridge} />}
      {!readOnly && <TerminalSettingPanel bridge={bridge} />}
      <Section divided className="settings-section">
        <SectionHeader
          title="모바일에서 진행 현황 보기"
          description="‘모바일에 공유’를 켠 콘텐츠의 제목·단계·다음 할 일·날짜·게시 링크만 보내요. 촬영 원본과 로컬 경로는 보내지 않아요."
          actions={
            <span className="share-count">
              공유 항목 {dashboard.projects.filter((p) => p.shared).length}
              개
            </span>
          }
        />
        <p className="ui-meta">
          마지막 현황 시각 · {readableTime(dashboard.updatedAt)}
        </p>
        {!readOnly && (
          <>
            <div className="button-row">
              <button
                className="secondary"
                onClick={() =>
                  run("현황 내보내기", async () => {
                    const path = await bridge.exportSnapshot();
                    if (path)
                      setNotice(`공유 현황을 내보냈어요: ${path}`);
                  })
                }
                disabled={!!busy}
              >
                공유 현황 내보내기
              </button>
            </div>
            <div className="settings-subsection">
              <h3>Sites 동기화 연결</h3>
              <p className="ui-meta">
                인증 토큰은 이 화면에서만 쓰고 저장하지 않아요.
              </p>
              <div className="settings-form">
                <label>
                  동기화 주소
                  <input
                    type="url"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                    placeholder="https://your-site.example/api/snapshot"
                    disabled={!!busy}
                  />
                </label>
                <label>
                  인증 토큰
                  <input
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="필요한 경우 입력"
                    disabled={!!busy}
                  />
                </label>
              </div>
              <button
                className="primary"
                onClick={() =>
                  run("현황 동기화", async () => {
                    const result = await bridge.syncSnapshot(
                      endpoint,
                      token,
                    );
                    setToken("");
                    setNotice(
                      `${result.count}개 콘텐츠를 ${readableTime(result.generatedAt)} 기준으로 동기화했어요.`,
                    );
                  })
                }
                disabled={!!busy || !endpoint}
              >
                선택한 현황 동기화
              </button>
            </div>
          </>
        )}
      </Section>
    </>
  );
}
