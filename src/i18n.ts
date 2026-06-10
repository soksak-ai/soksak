import { useSettings } from "./state/settings";

// 간단한 i18n: 메시지 키 → 한/영. useT() 가 현재 언어로 번역 함수를 돌려준다.
// {name} 형태 플레이스홀더는 params 로 치환.

const ko = {
  "common.loading": "로딩…",
  "common.refresh": "새로고침",
  "common.cancel": "취소",

  "project.close": "프로젝트 닫기",
  "project.new": "새 프로젝트",
  "project.newTitle": "새 프로젝트",
  "project.folder": "폴더",
  "project.pickFolder": "폴더 선택…",
  "project.alias": "별칭",
  "project.aliasPh": "폴더명",
  "project.program": "첫 프로그램",
  "project.create": "생성",
  "program.terminal": "터미널",
  "sidebar.toggle": "사이드바 토글 (⌘B)",
  "sidebar.resize": "사이드바 폭 조절",
  "bg.title": "배경색 지정",
  "bg.aria": "배경색",
  "theme.lightPreset": "라이트 프리셋",
  "theme.darkPreset": "다크 프리셋",
  "theme.toggle": "다크/라이트 전환",
  "settings.open": "설정",

  "view.terminal": "터미널",
  "view.close": "탭 닫기 (⌘W)",
  "view.newTerminal": "새 터미널 (⌘T)",

  "tree.refreshAria": "파일 트리 새로고침",

  "viewer.unsupported": "미리보기를 지원하지 않는 파일입니다.",
  "viewer.code": "코드",
  "viewer.preview": "프리뷰",
  "viewer.binFail": "미리보기를 불러올 수 없습니다.",
  "viewer.imgFail": "이미지를 불러올 수 없습니다.",
  "viewer.largeFile": "큰 파일 ({size}) — 구문 강조 비활성화",
  "viewer.truncated": "처음 {read}만 로드 (메모리 보호)",

  "settings.title": "설정",
  "settings.language": "언어",
  "settings.font": "폰트",
  "settings.fontFamily": "글꼴",
  "settings.fontSize": "크기",
  "settings.cursor": "커서",
  "settings.cursorBlink": "깜빡임",
  "settings.cursorStyle": "모양",
  "settings.cursorBlock": "블록",
  "settings.cursorBar": "바",
  "settings.cursorUnderline": "밑줄",
  "settings.scrollback": "스크롤백 줄 수",
  "settings.close": "닫기",
} as const;

export type MsgKey = keyof typeof ko;

const en: Record<MsgKey, string> = {
  "common.loading": "Loading…",
  "common.refresh": "Refresh",
  "common.cancel": "Cancel",

  "project.close": "Close project",
  "project.new": "New project",
  "project.newTitle": "New project",
  "project.folder": "Folder",
  "project.pickFolder": "Choose folder…",
  "project.alias": "Alias",
  "project.aliasPh": "folder name",
  "project.program": "Open with",
  "project.create": "Create",
  "program.terminal": "Terminal",
  "sidebar.toggle": "Toggle sidebar (⌘B)",
  "sidebar.resize": "Resize sidebar",
  "bg.title": "Set background color",
  "bg.aria": "Background color",
  "theme.lightPreset": "Light preset",
  "theme.darkPreset": "Dark preset",
  "theme.toggle": "Toggle light/dark",
  "settings.open": "Settings",

  "view.terminal": "Terminal",
  "view.close": "Close tab (⌘W)",
  "view.newTerminal": "New terminal (⌘T)",

  "tree.refreshAria": "Refresh file tree",

  "viewer.unsupported": "This file type can't be previewed.",
  "viewer.code": "Code",
  "viewer.preview": "Preview",
  "viewer.binFail": "Couldn't load the preview.",
  "viewer.imgFail": "Couldn't load the image.",
  "viewer.largeFile": "Large file ({size}) — syntax highlighting off",
  "viewer.truncated": "Loaded first {read} (memory guard)",

  "settings.title": "Settings",
  "settings.language": "Language",
  "settings.font": "Font",
  "settings.fontFamily": "Family",
  "settings.fontSize": "Size",
  "settings.cursor": "Cursor",
  "settings.cursorBlink": "Blink",
  "settings.cursorStyle": "Style",
  "settings.cursorBlock": "Block",
  "settings.cursorBar": "Bar",
  "settings.cursorUnderline": "Underline",
  "settings.scrollback": "Scrollback lines",
  "settings.close": "Close",
};

const messages = { ko, en };

export type TFn = (key: MsgKey, params?: Record<string, string | number>) => string;

// 현재 언어 기준 번역 함수. 언어가 바뀌면 구독 컴포넌트가 리렌더된다.
export function useT(): TFn {
  const lang = useSettings((s) => s.language);
  return (key, params) => {
    let s: string = messages[lang][key] ?? ko[key] ?? key;
    if (params) {
      for (const k in params) s = s.replace(`{${k}}`, String(params[k]));
    }
    return s;
  };
}
