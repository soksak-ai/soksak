import {
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import { Icon } from "../ui/icons/Icon";
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
  onWatchDegraded,
}: {
  rootAbs: string;
  initialChildren: Child[];
  onOpenFile: (absPath: string) => void;
  theme: TreeThemeInput;
  gitStatus: GitStatusEntry[];
  // 워처 등록 실패(권한/네트워크 볼륨 등 FSEvents 한계) 보고 — 침묵 실패 금지.
  onWatchDegraded: () => void;
}) {
  const themeStyles = useMemo(
    () =>
      ({
        ...(themeToTreeStyles(theme) as CSSProperties),
        // 라이브러리 기본 인라인 패딩(16px)·행 좌우 패딩이 좌측 공백으로 보임 →
        // 인라인 style 로 직접 축소(커스텀 엘리먼트라 인라인이 확실). 변수는 shadow
        // 로 상속되어 내부 var(--trees-padding-inline-override, …) 가 읽는다.
        "--trees-padding-inline-override": "2px",
        "--trees-item-padding-x-override": "2px",
      }) as CSSProperties,
    [theme],
  );

  // 로드된 디렉토리 rel 경로("" = 루트), 알려진 디렉토리 rel 경로(placeholder 추가됨).
  const loaded = useRef<Set<string>>(new Set());
  const knownDirs = useRef<Set<string>>(new Set());
  // 로드된 디렉토리별 현재 자식 이름 집합(워처 증분 reconcile 의 diff 기준).
  const childrenByDir = useRef<Map<string, Set<string>>>(new Map());
  // 감시 중인 절대경로(언마운트 시 일괄 해제용).
  const watchedAbs = useRef<Set<string>>(new Set());
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
        // 열자마자 선택 해제 — 선택이 남으면 (뷰를 닫고) 같은 파일을 다시
        // 클릭해도 selection-change 가 발화하지 않아 재열기가 안 된다.
        // 해제로 selected=[] 콜백이 한 번 더 오지만 이 루프는 무시한다.
        item.deselect();
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
      // 단일 자식 폴더 체인을 한 줄로 합치지 않는다(lazy placeholder 와 충돌 + 사용자가
      // 보고한 "일렬로 펼쳐지며 위로 올라가는" 버그 방지).
      flattenEmptyDirectories: false,
    }),
    [onSelectionChange],
  );
  const { model } = useFileTree(options);
  modelRef.current = model;

  // rel("") → 절대경로.
  const absOf = useCallback(
    (rel: string) =>
      rel === ""
        ? rootRef.current.replace(/\/+$/, "")
        : `${rootRef.current.replace(/\/+$/, "")}/${rel}`,
    [],
  );

  // rel 디렉토리를 OS 워처에 등록(폴링 없이 외부 변경 감지). 중복은 Rust 가 무시.
  // 실패는 삼키지 않고 보고 — 부모가 수동 새로고침 안전망(⟳)을 그때만 노출한다.
  const degradedRef = useRef(onWatchDegraded);
  degradedRef.current = onWatchDegraded;
  const watchDir = useCallback(
    (rel: string) => {
      const abs = absOf(rel);
      if (watchedAbs.current.has(abs)) return;
      watchedAbs.current.add(abs);
      invoke("watch_dir", { path: abs }).catch(() => degradedRef.current());
    },
    [absOf],
  );

  // rel 디렉토리의 자식들을 트리에 반영(placeholder 제거 + 실제 자식 추가). 최초 로드용.
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
      childrenByDir.current.set(rel, new Set(children.map((c) => c.name)));
      if (ops.length) model.batch(ops);
      watchDir(rel);
    },
    [model, watchDir],
  );

  // 워처 이벤트 → 해당 디렉토리만 다시 list 해 증분 반영(추가/삭제만, 펼침 상태 유지).
  const reconcile = useCallback(
    (rel: string, children: Child[]) => {
      const prev = childrenByDir.current.get(rel);
      if (!prev) {
        applyChildren(rel, children);
        return;
      }
      const next = new Set(children.map((c) => c.name));
      const ops: FileTreeBatchOperation[] = [];
      const wasEmpty = prev.size === 0;
      const nowEmpty = next.size === 0;
      // 빈→비어있지않음: placeholder 제거. 비어있지않음→빈: placeholder 복원.
      if (rel !== "" && wasEmpty && !nowEmpty) {
        ops.push({ type: "remove", path: `${rel}/${PH}` });
      }
      // 추가된 항목.
      for (const c of children) {
        if (prev.has(c.name)) continue;
        const p = rel === "" ? c.name : `${rel}/${c.name}`;
        if (c.dir) {
          ops.push({ type: "add", path: `${p}/${PH}` });
          knownDirs.current.add(p);
        } else {
          ops.push({ type: "add", path: p });
        }
      }
      // 삭제된 항목(서브트리 + 관련 ref/워처 정리).
      for (const name of prev) {
        if (next.has(name)) continue;
        const p = rel === "" ? name : `${rel}/${name}`;
        ops.push({ type: "remove", path: p });
        const isPrefix = (x: string) => x === p || x.startsWith(`${p}/`);
        for (const s of [...loaded.current]) if (isPrefix(s)) loaded.current.delete(s);
        for (const s of [...knownDirs.current])
          if (isPrefix(s)) knownDirs.current.delete(s);
        for (const k of [...childrenByDir.current.keys()])
          if (isPrefix(k)) childrenByDir.current.delete(k);
        for (const abs of [...watchedAbs.current]) {
          const pAbs = absOf(p);
          if (abs === pAbs || abs.startsWith(`${pAbs}/`)) {
            watchedAbs.current.delete(abs);
            invoke("unwatch_dir", { path: abs }).catch(() => {});
          }
        }
      }
      if (rel !== "" && !wasEmpty && nowEmpty) {
        ops.push({ type: "add", path: `${rel}/${PH}` });
      }
      childrenByDir.current.set(rel, next);
      if (ops.length) model.batch(ops);
    },
    [applyChildren, absOf, model],
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

  // 외부 변경(다른 프로그램의 파일 추가/삭제) 라이브 반영. 워처가 보낸 디렉토리 절대경로를
  // rel 로 바꿔, 로드된 디렉토리면 다시 list 후 reconcile. 폴링 없음(OS 이벤트 기반).
  useEffect(() => {
    const root = rootRef.current.replace(/\/+$/, "");
    const un = listen<string>("fs-change", (e) => {
      const absDir = e.payload.replace(/\/+$/, "");
      let rel: string;
      if (absDir === root) rel = "";
      else if (absDir.startsWith(`${root}/`))
        rel = absDir.slice(root.length + 1);
      else return; // 이 트리 밖
      if (!loaded.current.has(rel)) return; // 미로드(안 펼친) 디렉토리는 무시
      invoke<Listing>("list_children", { path: absDir })
        .then((l) => reconcile(rel, l.children))
        .catch(() => {});
    });
    return () => {
      void un.then((f) => f());
    };
  }, [reconcile]);

  // 언마운트(프로젝트 닫힘/루트 변경) 시 이 트리가 건 모든 워처 해제.
  useEffect(() => {
    const watched = watchedAbs.current;
    return () => {
      for (const abs of watched)
        invoke("unwatch_dir", { path: abs }).catch(() => {});
      watched.clear();
    };
  }, []);

  return <FileTree className="ft" style={themeStyles} model={model} />;
}

function FileTreeSidebarImpl({
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
  // 워처 등록 실패가 보고된 상태 — 이때만 수동 새로고침(⟳)을 노출한다(크러치의
  // 상시 노출 금지: 정상 환경에선 워처가 단일 진실). 루트가 바뀌면 재평가.
  const [watchDegraded, setWatchDegraded] = useState(false);
  // 명령 종료 시 git 상태만 갱신(재리스팅 X → 트리 펼침 상태 유지). 이벤트 기반.
  const [gitNonce, setGitNonce] = useState(0);

  // cwd 이벤트 구독(폴링 없음). paneId 가 바뀌면 재구독 + 현재값 반영.
  useEffect(() => {
    setCwd(getCwdOfHost(paneId));
    return subscribeCwd(paneId, setCwd);
  }, [paneId]);

  // 루트 변경 시 워처 열화 상태 재평가(새 위치는 정상일 수 있다).
  useEffect(() => {
    setWatchDegraded(false);
  }, [listing?.root]);

  // 명령 종료(OSC 133/633 D) 구독 → git 상태 갱신 트리거(폴링 없음).
  useEffect(() => {
    return subscribeCommandFinished(paneId, () => setGitNonce((n) => n + 1));
  }, [paneId]);

  // 외부 변경(soksak 밖의 에디터/터미널이 만든 git 변화)도 데코에 반영 — 워처의
  // fs-change(탐지 기반, 폴링 없음)를 git 상태 갱신으로 연결한다. 500ms 디바운스로
  // 대량 변경을 1회 갱신으로 합친다. ⟳ 버튼은 워처 실패(권한/드라이브 한계)용 안전망.
  useEffect(() => {
    const root = listing?.root?.replace(/\/+$/, "");
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const un = listen<string>("fs-change", (e) => {
      const dir = e.payload.replace(/\/+$/, "");
      if (dir !== root && !dir.startsWith(`${root}/`)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setGitNonce((n) => n + 1), 500);
    });
    return () => {
      if (timer) clearTimeout(timer);
      void un.then((f) => f());
    };
  }, [listing?.root]);

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
        {/* 워처가 이 위치를 감시하지 못할 때만 노출되는 안전망 — 정상 환경에선
            워처(FSEvents)가 단일 진실이라 수동 새로고침은 존재하지 않는다. */}
        {watchDegraded && (
          <button
            type="button"
            className="icon-btn ft-refresh"
            title={t("tree.watchDegraded")}
            aria-label={t("tree.refreshAria")}
            onClick={() => setNonce((n) => n + 1)}
          >
            <Icon name="refresh" />
          </button>
        )}
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
            onWatchDegraded={() => setWatchDegraded(true)}
          />
        ) : (
          <div className="ft-msg">{t("common.loading")}</div>
        )}
      </div>
    </div>
  );
}

// memo 경계(원칙 2).
export const FileTreeSidebar = memo(FileTreeSidebarImpl);
