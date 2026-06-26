// core kv 저장 헬퍼 — 코어 영속 상태(설정·레이아웃·window-manifest)의 단일 저장 추상.
//
// [RULE] 두 층을 합친다:
//  - localStorage(동기 부트 캐시): render 전 동기 로드가 가능해야 하므로(zustand load()) 유지.
//    "오프라인 1차 캐시"로 강등 — 권위가 아니다.
//  - app.data core ns(권위 + 크로스윈도우 broadcast): data_kv_set 이 전 창에 data-change emit →
//    다른 창이 같은 key 변경을 polling 0 으로 반영(localStorage 엔 이 채널이 없다 — 그래서 추가).
//
// write = 양쪽(동기 캐시 + 권위). boot = loadSync()로 즉시 그린 뒤 hydrate()로 권위값 반영.
// 권위가 비면(첫 실행/기존 사용자) localStorage 캐시를 app.data 로 1회 마이그레이션.

const NS = "core";

export interface CoreStoreDeps {
  invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  onDataChange: (cb: (key: string) => void) => () => void;
  localStorage: Pick<Storage, "getItem" | "setItem">;
}

export interface CoreStoreOpts<T> extends CoreStoreDeps {
  /** core ns 안의 kv 키(예: "settings", "theme", "layout/main/<root>"). */
  key: string;
  /** 동기 부트 캐시용 localStorage 키(기존 키 유지로 무중단 마이그레이션). */
  lsKey: string;
  fallback: T;
}

export interface CoreStore<T> {
  /** render 전 동기 — localStorage 캐시(없으면 fallback). */
  loadSync: () => T;
  /** 권위(app.data) + 캐시(localStorage) 양쪽 기록. */
  save: (value: T) => Promise<void>;
  /** 권위값을 읽어 캐시 갱신 후 반환. 권위가 비면 캐시를 권위로 1회 마이그레이션. */
  hydrate: () => Promise<T>;
  /** 다른 창의 같은 key data-change 시 최신 권위값을 콜백. 해지 함수 반환. */
  subscribe: (cb: (value: T) => void) => () => void;
}

export function makeCoreStore<T>(opts: CoreStoreOpts<T>): CoreStore<T> {
  const { key, lsKey, fallback, invoke, onDataChange, localStorage } = opts;

  // 이 창이 방금 쓴 값(직렬화). data-change broadcast 는 송신 창 자신도 받으므로(commands.rs 가 전 창 emit),
  // 그 self-echo 를 readRemote→apply 하면 불필요한 재렌더가 한 번 더 돈다. lastSavedJson 과 같으면 skip.
  let lastSavedJson: string | null = null;

  const writeCache = (value: T) => {
    try {
      localStorage.setItem(lsKey, JSON.stringify(value));
    } catch {
      /* 캐시 쓰기 실패는 치명 아님(권위는 app.data) */
    }
  };

  const loadSync = (): T => {
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw == null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };

  const readRemote = async (): Promise<T | null> => {
    const v = (await invoke("data_kv_get", { ns: NS, key })) as T | null;
    return v ?? null;
  };

  const save = async (value: T): Promise<void> => {
    lastSavedJson = JSON.stringify(value); // 이 값의 echo 는 self — subscribe 에서 skip
    writeCache(value);
    await invoke("data_kv_set", { ns: NS, key, value });
  };

  const hydrate = async (): Promise<T> => {
    const remote = await readRemote();
    if (remote != null) {
      writeCache(remote);
      return remote;
    }
    // 권위 비어있음 — 동기 캐시를 권위로 1회 마이그레이션(있을 때만).
    const cached = loadSync();
    await invoke("data_kv_set", { ns: NS, key, value: cached });
    return cached;
  };

  const subscribe = (cb: (value: T) => void): (() => void) =>
    onDataChange((changedKey) => {
      if (changedKey !== key) return;
      void readRemote().then((v) => {
        if (v == null) return;
        // self-echo(이 창이 방금 쓴 값)면 이미 스토어·캐시에 반영됨 — 재apply(재렌더) skip.
        if (JSON.stringify(v) === lastSavedJson) return;
        writeCache(v);
        cb(v);
      });
    });

  return { loadSync, save, hydrate, subscribe };
}
