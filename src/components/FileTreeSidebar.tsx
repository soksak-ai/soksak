import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  prepareFileTreeInput,
  themeToTreeStyles,
  type TreeThemeInput,
} from "@pierre/trees";
import { getCwdOfHost, subscribeCwd } from "../terminal/paneHosts";
import { useT } from "../i18n";

// 사이드바 파일 트리: 추적 대상 pane 터미널의 cwd 를 @pierre/trees 로 렌더한다.
// cwd 는 OSC 7 이벤트로 따라가고(폴링 없음), Rust list_dir 가 파일 경로 목록을 준다.
// 파일을 클릭(선택)하면 onOpenFile 로 절대경로를 올려 콘텐츠 영역에 파일 탭을 연다.

interface Listing {
  root: string;
  paths: string[];
  truncated: boolean;
}

const baseName = (p?: string) =>
  p ? (p.split("/").filter(Boolean).pop() ?? p) : undefined;

// 트리 내부 스크롤바도 얇고 배경색과 흡사하게(전역 CSS 는 shadow DOM 에 닿지 않음).
const TREE_SCROLLBAR_CSS = `
::-webkit-scrollbar{-webkit-appearance:none;width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(127,127,127,0.22);border-radius:2px}
::-webkit-scrollbar-thumb:hover{background:rgba(127,127,127,0.42)}
::-webkit-scrollbar-corner{background:transparent}
`;

// 경로 목록 → 트리 모델 → 렌더. root 가 바뀌면 부모가 key 로 remount 해 새 모델을 만든다.
function TreeView({
  paths,
  root,
  onOpenFile,
  theme,
}: {
  paths: string[];
  root: string;
  onOpenFile: (absPath: string) => void;
  theme: TreeThemeInput;
}) {
  const fileSet = useMemo(() => new Set(paths), [paths]);
  // docs 권장: scalable 트리는 raw paths 대신 prepareFileTreeInput(미리 shaping)으로.
  const preparedInput = useMemo(() => prepareFileTreeInput(paths), [paths]);
  // 앱 테마 → 트리 CSS 변수(--trees-theme-*). 호스트 inline style 로 shadow DOM 에 전달.
  const themeStyles = useMemo(
    () => themeToTreeStyles(theme) as CSSProperties,
    [theme],
  );

  // 콜백 안에서 항상 최신값을 보도록 ref 로 고정(useFileTree 옵션 churn 방지).
  const rootRef = useRef(root);
  rootRef.current = root;
  const fileSetRef = useRef(fileSet);
  fileSetRef.current = fileSet;
  const openRef = useRef(onOpenFile);
  openRef.current = onOpenFile;

  const onSelectionChange = useCallback((selected: readonly string[]) => {
    // 선택된 것 중 파일을 연다(폴더는 무시). 보통 단일 선택.
    for (let i = selected.length - 1; i >= 0; i--) {
      const rel = selected[i];
      if (fileSetRef.current.has(rel)) {
        const r = rootRef.current.replace(/\/+$/, "");
        openRef.current(`${r}/${rel}`);
        return;
      }
    }
  }, []);

  const { model } = useFileTree({
    preparedInput,
    onSelectionChange,
    unsafeCSS: TREE_SCROLLBAR_CSS,
    density: "compact", // 행 간격 축소
  });
  return <FileTree className="ft" style={themeStyles} model={model} />;
}

export function FileTreeSidebar({
  paneId,
  onOpenFile,
  theme,
}: {
  paneId: string;
  onOpenFile: (absPath: string) => void;
  theme: TreeThemeInput;
}) {
  const t = useT();
  const [cwd, setCwd] = useState<string | undefined>(() =>
    getCwdOfHost(paneId),
  );
  const [nonce, setNonce] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);

  // cwd 이벤트 구독(폴링 없음). paneId 가 바뀌면 재구독 + 현재값 반영.
  useEffect(() => {
    setCwd(getCwdOfHost(paneId));
    return subscribeCwd(paneId, setCwd);
  }, [paneId]);

  // cwd(또는 새로고침) → 디렉토리 리스팅. cwd 미확인이면 path=null → Rust 가 HOME 사용.
  useEffect(() => {
    let cancelled = false;
    invoke<Listing>("list_dir", { path: cwd ?? null })
      .then((l) => {
        if (!cancelled) {
          setListing(l);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, nonce]);

  return (
    <div className="ft-sidebar">
      <div className="ft-header">
        <span className="ft-title" title={listing?.root}>
          {baseName(listing?.root) ?? "…"}
        </span>
        <button
          type="button"
          className="ft-refresh"
          title={t("common.refresh")}
          aria-label={t("tree.refreshAria")}
          onClick={() => setNonce((n) => n + 1)}
        >
          ⟳
        </button>
      </div>
      <div className="ft-body">
        {error ? (
          <div className="ft-msg">{error}</div>
        ) : listing ? (
          <TreeView
            key={listing.root}
            paths={listing.paths}
            root={listing.root}
            onOpenFile={onOpenFile}
            theme={theme}
          />
        ) : (
          <div className="ft-msg">{t("common.loading")}</div>
        )}
      </div>
    </div>
  );
}
