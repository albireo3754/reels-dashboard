import { expect, type Frame, type Page } from "@playwright/test";

/** The standalone editor page (web specs) or the embedded editor frame (Electron specs). */
type EditorScope = Page | Frame;

/**
 * 정본 에디터 상단 바의 ⋯(더 보기) 메뉴를 연다. 사진 넣기·스티커·본문 폭·변경분 검토·묶음 삭제·
 * 다시 불러오기는 이 메뉴 안에 있다.
 */
export async function openEditorMenu(scope: EditorScope) {
  await scope.getByRole("button", { name: "더 보기", exact: true }).click();
  const menu = scope.getByRole("menu", { name: "편집 메뉴" });
  await expect(menu).toBeVisible();
  return menu;
}

/** ⋯ 메뉴를 열어 항목 하나를 고른다(고르면 메뉴는 닫힌다). */
export async function chooseEditorMenu(
  scope: EditorScope,
  name: string | RegExp,
  role: "menuitem" | "menuitemcheckbox" = "menuitem",
) {
  const menu = await openEditorMenu(scope);
  await menu.getByRole(role, { name, exact: typeof name === "string" }).click();
  await expect(menu).toHaveCount(0);
}

/** 열린 ⋯ 메뉴를 Esc로 닫는다. */
export async function closeEditorMenu(scope: EditorScope) {
  const menu = scope.getByRole("menu", { name: "편집 메뉴" });
  // Esc on the trigger closes an open menu and keeps focus there.
  await scope.getByRole("button", { name: "더 보기", exact: true }).press("Escape");
  await expect(menu).toHaveCount(0);
}
