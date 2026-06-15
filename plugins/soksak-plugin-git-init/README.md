# soksak-plugin-git-init

새 프로젝트의 루트에 `.git` 이 없으면 자동으로 `git init` 하는 soksak
플러그인. 기존 이벤트(`project.created`)와 명령(`git.init`)만 조합한다 —
자체 백엔드 0줄.

## 동작

프로젝트가 생성되면(`project.created`) 루트를 `git.init` 명령에 넘긴다.
`.git` 이 이미 있으면 no-op(멱등).

## 명령으로도 동일

```bash
sok git.init '{"path":"/Users/me/work"}'   # 수동 실행(생략 시 활성 프로젝트 루트)
```

## 권한

- `commands` — `git.init` 명령 실행
