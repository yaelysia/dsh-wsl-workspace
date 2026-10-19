# DSH WSL Workspace — 한국어 안내

[English](README.md) · [简体中文](README.zh.md)

**Windows에서 DSH를 실행하면서 WSL의 프로젝트 폴더를 직접 작업하는 플러그인입니다.**
DSH의 UI, 모델 및 세션은 Windows에 두고, 명령 실행, 파일 작업, `grep` / `glob` 검색은
선택한 Linux 배포판에서 처리합니다. WSL에 DSH를 별도로 설치할 필요가 없습니다.

## 요구 사항

Windows용 DSH, 사용 가능한 WSL 배포판, WSL의 `python3`(Python 3.8 이상)이 필요합니다.

## 설치

Windows DSH 플러그인 관리 화면에서 **이 fork의 Git 주소**를 추가합니다.

```text
git+https://github.com/yaelysia/dsh-wsl-workspace.git#main
```

활성화한 뒤 **DSH 호스트 프로세스를 완전히 종료하고 다시 시작**하세요.
원본 프로젝트의 동명 npm 패키지는 이 fork의 개선 사항을 포함하지 않습니다.
업데이트할 때에는 설치된 Git 커밋을 확인하세요.

## 사용 방법

설정 옆의 **W** 버튼으로 배포판, 필요하면 Linux 사용자, 작업 디렉터리
(예: `/home/me/project`)를 선택합니다. 일반적인 `read` / `write` / `edit`,
`grep` / `glob`, `bash` 도구를 그대로 사용할 수 있습니다.
Windows 파일은 `/mnt/c/...` 경로로 접근합니다. 파일과 검색은 설정이 같을 때
같은 RPC 워커를 재사용하며 유휴 상태 후 다시 시작할 수 있습니다.

설정, 진단, 파일 크기 및 권한 제한은
[English README](README.md) 또는 [中文 README](README.zh.md)를 참고하세요.
실시간 프로필 재로드는 DSH 자체 기능이므로 완전한 재시작이 필요할 수 있습니다.

## 원본 프로젝트 및 라이선스

**Fork 원본:** https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace

**현재 fork:** https://github.com/yaelysia/dsh-wsl-workspace

독립적으로 유지보수되는 파생 버전이며 DSH 공식 배포판이 아닙니다.
**MIT** 라이선스: [LICENSE](LICENSE), [NOTICE](NOTICE).
