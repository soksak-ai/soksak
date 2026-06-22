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
}

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

  const save = (value: T): void => {
    if (store) void store.save(value); // ls + app.data
    else writeCache(value); // 부트 전 — ls 만
  };

  const init = (deps: CoreStoreDeps): (() => void) => {
    store = makeCoreStore<T>({ key, lsKey, fallback, ...deps });
    void store.hydrate().then(apply);
    return store.subscribe(apply);
  };

  return { loadSync, save, init };
}
