import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import CodeMirror from "@uiw/react-codemirror";
import {
  langNames,
  loadLanguage,
  type LanguageName,
} from "@uiw/codemirror-extensions-langs";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useT } from "../i18n";
import { useSessions } from "../state/sessions";

// 파일 뷰어: 확장자로 렌더 전략을 정한다.
//   - text      : CodeMirror (코드)
//   - markdown  : CodeMirror ↔ 렌더 프리뷰 토글
//   - svg       : CodeMirror ↔ 이미지 프리뷰 토글
//   - image/pdf/video/audio : 바이너리 프리뷰(asset 프로토콜 스트리밍)
// 텍스트 내용은 read_text_file(UTF-8 검증)로 읽고, 실패(바이너리)면 폴백 메시지.

type StrategyKind =
  | "text"
  | "markdown"
  | "svg"
  | "image"
  | "pdf"
  | "video"
  | "audio";

const IMAGE = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "apng",
]);
const VIDEO = new Set(["mp4", "webm", "mov", "m4v", "ogv", "mkv"]);
const AUDIO = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac"]);

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}KB`;
  return `${n}B`;
}

// 파일명 끝의 확장자(소문자). 'Makefile'/'.zshrc' 처럼 확장자 없는 경우는 "".
function extOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

function strategyFor(path: string): StrategyKind {
  const e = extOf(path);
  if (e === "svg") return "svg";
  if (e === "md" || e === "markdown") return "markdown";
  if (e === "pdf") return "pdf";
  if (IMAGE.has(e)) return "image";
  if (VIDEO.has(e)) return "video";
  if (AUDIO.has(e)) return "audio";
  return "text";
}

// @uiw/codemirror-extensions-langs 의 langs 는 확장자 키로 되어 있다(예: ts, rs, go, py).
// 그래서 확장자를 그대로 키로 쓰되, 패키지가 제공하는 실제 유효 키 집합(langNames)으로
// 검증한다(하드코딩 추측 금지). 확장자 ≠ 키인 소수만 별칭으로 보정.
const VALID_LANGS = new Set<string>(langNames as string[]);
const LANG_ALIAS: Record<string, string> = {
  zsh: "bash",
};

function languageExtensionFor(path: string) {
  const key = LANG_ALIAS[extOf(path)] ?? extOf(path);
  return VALID_LANGS.has(key) ? loadLanguage(key as LanguageName) : null;
}

export interface FileViewerProps {
  path: string;
  mode: "code" | "preview";
  isDark: boolean;
  projectId: string;
  viewId: string;
  onMode: (mode: "code" | "preview") => void;
}

export function FileViewer({
  path,
  mode,
  isDark,
  projectId,
  viewId,
  onMode,
}: FileViewerProps) {
  const t = useT();
  const setFileDirty = useSessions((s) => s.setFileDirty);
  const strat = strategyFor(path);
  const previewable = strat === "markdown" || strat === "svg";
  const needsText = strat === "text" || strat === "markdown" || strat === "svg";
  const needsBinary =
    strat === "image" ||
    strat === "pdf" ||
    strat === "video" ||
    strat === "audio";

  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<{
    read: number;
    total: number;
    truncated: boolean;
    lines: number;
  } | null>(null);
  const [binUrl, setBinUrl] = useState<string | null>(null);
  const [binError, setBinError] = useState<string | null>(null);
  // 디스크에 저장된 마지막 내용(dirty 판정 기준). 편집 내용(text)과 다르면 미저장.
  const savedRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!needsText) return;
    let cancelled = false;
    setText(null);
    setError(null);
    setInfo(null);
    invoke<{
      content: string;
      truncated: boolean;
      read_bytes: number;
      total_bytes: number;
      line_count: number;
    }>("read_text_file", { path })
      .then((d) => {
        if (cancelled) return;
        setText(d.content);
        savedRef.current = d.content;
        setFileDirty(projectId, viewId, false);
        setInfo({
          read: d.read_bytes,
          total: d.total_bytes,
          truncated: d.truncated,
          lines: d.line_count,
        });
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path, needsText, projectId, viewId, setFileDirty]);

  // editor 의 isTooLargeForTokenization 과 동일: 20MiB 초과 또는 30만 줄 초과면
  // 구문 강조/폴딩을 끈다(Lezer 전체 파싱 폭주 방지).
  const isLarge =
    info != null && (info.total > 20 * 1024 * 1024 || info.lines > 300_000);

  // 바이너리 프리뷰: Rust 가 base64 + MIME 로 읽어주면 data URL 로 렌더(asset 프로토콜 X).
  useEffect(() => {
    if (!needsBinary) return;
    let cancelled = false;
    setBinUrl(null);
    setBinError(null);
    invoke<{ mime: string; base64: string }>("read_file_base64", { path })
      .then((d) => {
        if (!cancelled) setBinUrl(`data:${d.mime};base64,${d.base64}`);
      })
      .catch((e) => {
        if (!cancelled) setBinError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path, needsBinary]);

  // SVG 프리뷰는 이미 읽은 텍스트를 data URL 로(별도 읽기 불필요).
  const svgUrl = useMemo(
    () =>
      strat === "svg" && text != null
        ? `data:image/svg+xml;utf8,${encodeURIComponent(text)}`
        : null,
    [strat, text],
  );

  const cmExtensions = useMemo(() => {
    if (isLarge) return []; // 큰 파일은 강조 비활성화
    const ext = languageExtensionFor(path);
    return ext ? [ext] : [];
  }, [path, isLarge]);

  const markdownHtml = useMemo(() => {
    if (strat !== "markdown" || text == null) return "";
    const raw = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [strat, text]);

  // 잘린(truncated) 파일은 앞부분만 읽었으므로 저장하면 나머지가 날아간다 → 편집 금지.
  // 바이너리/프리뷰 전용도 편집 불가. 그 외 텍스트 계열만 편집 가능.
  const editable = needsText && info != null && !info.truncated;
  const [saveError, setSaveError] = useState<string | null>(null);

  const onChange = useCallback(
    (v: string) => {
      setText(v);
      setFileDirty(projectId, viewId, v !== savedRef.current);
    },
    [projectId, viewId, setFileDirty],
  );

  const save = useCallback(async () => {
    if (!editable || text == null || saving || text === savedRef.current) return;
    setSaving(true);
    setSaveError(null);
    try {
      await invoke("write_text_file", { path, content: text });
      savedRef.current = text;
      setFileDirty(projectId, viewId, false);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [editable, text, saving, path, projectId, viewId, setFileDirty]);

  // ⌘S/Ctrl+S 저장. 캡처 단계에서 가로채 CodeMirror/브라우저 기본동작보다 먼저 처리.
  const onKeyDownSave = useCallback(
    (e: ReactKeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void save();
      }
    },
    [save],
  );

  const dirty = editable && text != null && text !== savedRef.current;

  const codeBody = () => {
    if (error) {
      return (
        <div className="fv-msg">
          {t("viewer.unsupported")}
          <br />
          <span className="fv-msg-sub">{error}</span>
        </div>
      );
    }
    if (text == null) return <div className="fv-msg">{t("common.loading")}</div>;
    return (
      <div className="fv-code" onKeyDownCapture={onKeyDownSave}>
        {(info && (isLarge || info.truncated)) || saveError || dirty ? (
          <div className="fv-banner">
            {isLarge && t("viewer.largeFile", { size: fmtBytes(info!.total) })}
            {info?.truncated &&
              `${isLarge ? " · " : ""}${t("viewer.truncated", { read: fmtBytes(info.read) })}`}
            {saveError && (
              <span className="fv-banner-err">
                {(isLarge || info?.truncated ? " · " : "") +
                  t("viewer.saveFailed", { err: saveError })}
              </span>
            )}
            {dirty && !saveError && (
              <span className="fv-banner-dirty">
                {(isLarge || info?.truncated ? " · " : "") +
                  (saving ? t("viewer.saving") : t("viewer.unsaved"))}
              </span>
            )}
          </div>
        ) : null}
        <CodeMirror
          className="fv-cm"
          value={text}
          height="100%"
          theme={isDark ? "dark" : "light"}
          extensions={cmExtensions}
          editable={editable}
          onChange={editable ? onChange : undefined}
          basicSetup={{
            lineNumbers: true,
            foldGutter: !isLarge,
            highlightActiveLine: editable,
            highlightActiveLineGutter: editable,
          }}
        />
      </div>
    );
  };

  // 바이너리 data URL 로딩/에러 처리 후 render 콜백으로 렌더.
  const binaryBody = (render: (url: string) => ReactNode): ReactNode => {
    if (binError) {
      return (
        <div className="fv-msg">
          {t("viewer.binFail")}
          <br />
          <span className="fv-msg-sub">{binError}</span>
        </div>
      );
    }
    if (!binUrl) return <div className="fv-msg">{t("common.loading")}</div>;
    return render(binUrl);
  };

  const body = (): ReactNode => {
    switch (strat) {
      case "image":
        return binaryBody((url) => <ImagePreview url={url} />);
      case "svg":
        if (mode !== "preview") return codeBody();
        return svgUrl ? (
          <ImagePreview url={svgUrl} />
        ) : (
          <div className="fv-msg">{t("common.loading")}</div>
        );
      case "markdown":
        return mode === "preview" ? (
          <div
            className="fv-markdown"
            // marked → DOMPurify 살균 후 렌더(로컬 파일이지만 방어적 살균).
            dangerouslySetInnerHTML={{ __html: markdownHtml }}
          />
        ) : (
          codeBody()
        );
      case "pdf":
        return binaryBody((url) => (
          <embed className="fv-embed" src={url} type="application/pdf" />
        ));
      case "video":
        return binaryBody((url) => (
          <video className="fv-media" src={url} controls />
        ));
      case "audio":
        return binaryBody((url) => (
          <div className="fv-audio-wrap">
            <audio src={url} controls />
          </div>
        ));
      case "text":
      default:
        return codeBody();
    }
  };

  return (
    <div className="file-viewer">
      {previewable && (
        <div className="fv-toolbar">
          <div className="fv-modes">
            <button
              type="button"
              className={`fv-mode${mode === "code" ? " active" : ""}`}
              onClick={() => onMode("code")}
            >
              {t("viewer.code")}
            </button>
            <button
              type="button"
              className={`fv-mode${mode === "preview" ? " active" : ""}`}
              onClick={() => onMode("preview")}
            >
              {t("viewer.preview")}
            </button>
          </div>
        </div>
      )}
      <div className="fv-body">{body()}</div>
    </div>
  );
}

function ImagePreview({ url }: { url: string }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <div className="fv-msg">{t("viewer.imgFail")}</div>;
  }
  return (
    <div className="fv-image-wrap">
      <img className="fv-image" src={url} onError={() => setFailed(true)} />
    </div>
  );
}
