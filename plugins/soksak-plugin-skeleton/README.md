# soksak-plugin-skeleton

soksak 플러그인을 만들기 위한 **시작 템플릿 + 완전 매뉴얼**.

- **`MANUAL.md`** — soksak 플러그인 개발 완전판. 무엇이 가능한지(권한·기여·API),
  무엇을 할 수 있는지(패턴), 무엇을 해야 하는지(생명주기·규율·퍼포먼스)를 전부 담는다.
- **`main.js`** — 동작하는 최소 예제. 뷰(mount/unmount) + 명령(register/execute) +
  이벤트 구독 + 정리(subscriptions)를 코드로 보여준다.
- **`plugin.json`** — 최소 유효 매니페스트(권한 `ui`,`commands` + 뷰 1 + 명령 1).

## 빠른 시작

```
# 1) 이 폴더를 복제해 새 플러그인 시작(id/디렉토리명 변경)
cp -r soksak-plugin-skeleton my-plugin && cd my-plugin
#    plugin.json 의 "id" 를 디렉토리명과 동일하게 바꾼다.

# 2) 개발 로드(앱 실행 중)
sok plugin.dev.load '{"path":"/abs/path/to/my-plugin"}'
sok plugin.reload

# 3) 명령 호출
sok plugin.my-plugin.ping '{"name":"world"}'
#    사이드바 우측에 "스켈레톤" 뷰가 뜬다.
```

## 핵심 규율 (자세히는 MANUAL §8)

- 단일 ESM, `import` 문 금지(블롭 로드).
- 등록물·부수효과는 `ctx.subscriptions` 로 전부 정리 가능하게.
- 권한(permissions)·기여(contributes)와 사용을 정합. 실패를 침묵하지 말 것.
- 신뢰 모델 = full-trust(권한은 고지). 신뢰 가능한 코드만.

자유 위치 오버레이/마스코트, 브라우저 위 렌더, 퍼포먼스 격리 같은 고급 패턴은 MANUAL §10~§11.

## License

MIT
