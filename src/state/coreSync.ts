// createCoreSync — zustand 영속 스토어(settings/theme/plugins/…)를 coreStore 에 잇는 얇은 글루.
//
// [RULE] 코어 영속 상태의 권위는 app.data(멀티창 broadcast). localStorage 는 동기 부트 캐시일 뿐이다
// (render 전 동기 로드용). 각 스토어는 직렬화 상태 T 만 제공하면 되고, 이 글루가:
//  - loadSync(): 모듈 init 시 ls 캐시로 즉시 채움(없으면 fallback).
//  - save(T): 부트 전엔 ls 만, init(deps) 후엔 ls+app.data(coreStore.save).
//  - init(deps): app.data 권위값 hydrate → apply, 다른 창 변경 subscribe → apply. 첫 실행이면
//    coreStore 가 ls 캐시를 app.data 로 1회 마이그레이션(무중단). 해지 함수 반환.

import { makeCoreStore, type CoreStore, type CoreStoreDeps } from "./coreStore";

export interface CoreSync<T> {
  loadSync: () => T;
  save: (value: T) => void;
  init: (deps: CoreStoreDeps) => () => void;
  /** 잔여 디바운스 권위 기록을 즉시 비운다(pagehide·해지·테스트). */
  flush: () => void;
}

// 권위(app.data: SQLite 쓰기 + 전 창 broadcast) persist 디바운스 — ⌘± autorepeat·슬라이더 드래그 같은
// 연타가 키마다 디스크/IPC/broadcast 폭풍을 일으키지 않게 정착값 1회로 접는다. 라이브 UI(메모리 set)·동기
// 캐시(localStorage)는 즉시라 반응성·crash-safe 부트는 유지. 트레일링 엣지(마지막 변경 후 이만큼 조용하면 1회).
const PERSIST_DEBOUNCE_MS = 300;

export function createCoreSync<T>(opts: {
  /** core ns 안의 kv 키. */
  key: string;
  /** 동기 부트 캐시 localStorage 키(기존 키 유지로 무중단). */
  lsKey: string;
  fallback: T;
  /** 권위값(app.data hydrate / 다른 창 broadcast)을 스토어에 반영. */
  apply: (value: T) => void;
}): CoreSync<T> {
  const { key, lsKey, fallback, apply } = opts;
  let store: CoreStore<T> | null = null;
  // 디바운스 대기 중인 권위 기록 값(트레일링 — 최신 값만 보관). null = 대기 없음.
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const writeCache = (value: T) => {
    try {
      window.localStorage.setItem(lsKey, JSON.stringify(value));
    } catch {
      /* 캐시 쓰기 실패는 치명 아님 — 권위는 app.data */
    }
  };

  const loadSync = (): T => {
    try {
      const raw = window.localStorage.getItem(lsKey);
      return raw == null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  };

  // 잔여 권위 기록 즉시 비움(디바운스 만료·flush·해지). store.save = ls(중복·무해) + app.data 권위.
  const flush = (): void => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending && store) {
      const v = pending.value;
      pending = null;
      void store.save(v);
    }
  };

  const save = (value: T): void => {
    writeCache(value); // 즉시 — 동기 캐시(부트 crash-safe). localStorage 는 IPC 없이 싸다.
    if (!store) return; // 부트 전 — 캐시만(app.data 미접근).
    // in-memory 권위 즉시 세운다(read-your-writes): 디스크(SQLite) flush 는 아래서 디바운스하지만, 그 창의
    // 후속 권위 읽기(hydrate/subscribe)는 방금 쓴 값을 봐야 한다(디스크가 옛 값이어도 stale 로 안 덮음).
    store.stage(value);
    // 권위 디스크 flush(SQLite + 전 창 broadcast)만 디바운스 — 연타를 정착값 1회로 접는다.
    pending = { value };
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
  };

  const init = (deps: CoreStoreDeps): (() => void) => {
    store = makeCoreStore<T>({ key, lsKey, fallback, ...deps });
    void store.hydrate().then(apply);
    const unsub = store.subscribe(apply);
    // 창 닫힘 직전 잔여 기록 flush — 디바운스 창(≤300ms) 내 종료 시 마지막 변경 유실 방지(crash-safe 보강).
    const onHide = () => flush();
    if (typeof window !== "undefined") window.addEventListener("pagehide", onHide);
    return () => {
      flush(); // 해지 시 잔여 기록
      if (typeof window !== "undefined") window.removeEventListener("pagehide", onHide);
      unsub();
    };
  };

  return { loadSync, save, init, flush };
}
