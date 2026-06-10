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
  themeToTreeStyles,
  type FileTreeBatchOperation,
  type FileTreeDirectoryHandle,
  type GitStatusEntry,
  type TreeThemeInput,
} from "@pierre/trees";
import {
  getCwdOfHost,
  subscribeCommandFinished,
  subscribeCwd,
} from "../terminal/paneHosts";
import { useT } from "../i18n";

// 사이드바 파일 트리: lazy loading. 한 디렉토리의 직속 자식만 로드하고, 폴더를 펼칠 때
// 그 폴더의 자식을 추가한다(거대 디렉토리도 펼치기 전엔 한 줄). @pierre/trees 는 빈 폴더를
// 표현 못 하므로, 각 폴더에 보이지 않는 placeholder 자식을 두어 "펼침 가능"으로 만들고
// 펼칠 때 실제 자식으로 교체한다.

interface Child {
  name: string;
  dir: boolean;
}
interface Listing {
  root: string;
  children: Child[];
}

// 폴더를 펼침 가능하게 만드는 보이지 않는 placeholder 파일명(실제 파일과 충돌 불가).
const PH = "​";
const EMPTY_PATHS: readonly string[] = [];

const baseName = (p?: string) =>
  p ? (p.split("/").filter(Boolean).pop() ?? p) : undefined;

const TREE_SCROLLBAR_CSS = `
::-webkit-scrollbar{-webkit-appearance:none;width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(127,127,127,0.22);border-radius:2px}
::-webkit-scrollbar-thumb:hover{background:rgba(127,127,127,0.42)}
::-webkit-scrollbar-corner{background:transparent}
`;

function LazyTree({
  rootAbs,
  initialChildren,
  onOpenFile,
  theme,
  gitStatus,
}: {
  rootAbs: string;
  initialChildren: Child[];
  onOpenFile: (absPath: string) => void;
  theme: TreeThemeInput;
  gitStatus: GitStatusEntry[];
}) {
  const themeStyles = useMemo(
    () => themeToTreeStyles(theme) as CSSProperties,
    [theme],
  );

  // 로드된 디렉토리 rel 경로("" = 루트), 알려진 디렉토리 rel 경로(placeholder 추가됨).
  const loaded = useRef<Set<string>>(new Set());
  const knownDirs = useRef<Set<string>>(new Set());
  const modelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const rootRef = useRef(rootAbs);
  rootRef.current = rootAbs;
  const openRef = useRef(onOpenFile);
  openRef.current = onOpenFile;

  // 파일 선택(클릭) → 열기. 폴더/placeholder 는 무시(폴더는 라이브러리가 펼침 처리).
  const onSelectionChange = useCallback((selected: readonly string[]) => {
    for (let i = selected.length - 1; i >= 0; i--) {
      const rel = selected[i];
      if (rel.endsWith(PH)) continue;
      const item = modelRef.current?.getItem(rel);
      if (item && !item.isDirectory()) {
        const r = rootRef.current.replace(/\/+$/, "");
        openRef.current(`${r}/${rel}`);
        return;
      }
    }
  }, []);

  const options = useMemo(
    () => ({
      paths: EMPTY_PATHS,
      onSelectionChange,
      unsafeCSS: TREE_SCROLLBAR_CSS,
      density: "compact" as const,
    }),
    [onSelectionChange],
  );
  const { model } = useFileTree(options);
  modelRef.current = model;

  // rel 디렉토리의 자식들을 트리에 반영(placeholder 제거 + 실제 자식 추가).
  const applyChildren = useCallback(
    (rel: string, children: Child[]) => {
      const ops: FileTreeBatchOperation[] = [];
      // 빈 폴더는 placeholder 를 남겨 폴더 자체가 사라지지 않게 한다(라이브러리 제약).
      if (rel !== "" && children.length > 0) {
        ops.push({ type: "remove", path: `${rel}/${PH}` });
      }
      for (const c of children) {
        const p = rel === "" ? c.name : `${rel}/${c.name}`;
        if (c.dir) {
          ops.push({ type: "add", path: `${p}/${PH}` });
          knownDirs.current.add(p);
        } else {
          ops.push({ type: "add", path: p });
        }
      }
      loaded.current.add(rel);
      if (ops.length) model.batch(ops);
    },
    [model],
  );

  // rel 디렉토리를 fetch 해서 반영(미로드 시). 펼침 감지에서 호출.
  const loadDir = useCallback(
    (rel: string) => {
      if (loaded.current.has(rel)) return;
      loaded.current.add(rel); // async 동안 중복 로드 방지(optimistic)
      const abs = rel === "" ? rootRef.current : `${rootRef.current}/${rel}`;
      invoke<Listing>("list_children", { path: abs })
        .then((l) => applyChildren(rel, l.children))
        .catch(() => {});
    },
    [applyChildren],
  );

  // 최초: 루트 자식(이미 받은 initialChildren)을 반영.
  useEffect(() => {
    applyChildren("", initialChildren);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 펼침 감지: 모델 변경마다 알려진 디렉토리 중 "펼쳐졌고 미로드"인 것을 로드.
  useEffect(() => {
    const handle = () => {
      for (const dir of knownDirs.current) {
        if (loaded.current.has(dir)) continue;
        const item = model.getItem(dir);
        if (item?.isDirectory() && (item as FileTreeDirectoryHandle).isExpanded()) {
          loadDir(dir);
        }
      }
    };
    return model.subscribe(handle);
  }, [model, loadDir]);

  // git 상태 데코레이션 라이브 적용(로드된 경로만 매칭, 나머지는 무시).
  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

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
  const [gitStatus, setGitStatus] = useState<GitStatusEntry[]>([]);
  // 명령 종료 시 git 상태만 갱신(재리스팅 X → 트리 펼침 상태 유지). 이벤트 기반.
  const [gitNonce, setGitNonce] = useState(0);

  // cwd 이벤트 구독(폴링 없음). paneId 가 바뀌면 재구독 + 현재값 반영.
  useEffect(() => {
    setCwd(getCwdOfHost(paneId));
    return subscribeCwd(paneId, setCwd);
  }, [paneId]);

  // 명령 종료(OSC 133/633 D) 구독 → git 상태 갱신 트리거(폴링 없음).
  useEffect(() => {
    return subscribeCommandFinished(paneId, () => setGitNonce((n) => n + 1));
  }, [paneId]);

  // cwd(또는 새로고침) → 루트 + 직속 자식. cwd 미확인이면 path=null → Rust 가 HOME 사용.
  useEffect(() => {
    let cancelled = false;
    invoke<Listing>("list_children", { path: cwd ?? null })
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

  // 루트의 git 상태(데코레이션). git repo 가 아니면 빈 목록. cwd/새로고침/명령종료 시 갱신.
  useEffect(() => {
    const root = listing?.root;
    if (!root) {
      setGitStatus([]);
      return;
    }
    let cancelled = false;
    invoke<GitStatusEntry[]>("git_status", { path: root })
      .then((s) => {
        if (!cancelled) setGitStatus(s);
      })
      .catch(() => {
        if (!cancelled) setGitStatus([]);
      });
    return () => {
      cancelled = true;
    };
  }, [listing?.root, nonce, gitNonce]);

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
          <LazyTree
            key={listing.root}
            rootAbs={listing.root}
            initialChildren={listing.children}
            onOpenFile={onOpenFile}
            theme={theme}
            gitStatus={gitStatus}
          />
        ) : (
          <div className="ft-msg">{t("common.loading")}</div>
        )}
      </div>
    </div>
  );
}
