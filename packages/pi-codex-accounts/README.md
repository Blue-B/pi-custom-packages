# pi-codex-accounts

> ChatGPT Codex 멀티 계정 로테이션 + 한도 시각화 for pi. `429`에서 자동 전환, `5시간/7일` 바와 절대 리셋 날짜, 현재 계정 하이라이트.

## Why

Codex는 계정당 `5시간`과 `7일` 윈도우로 할당량을 잰다. pi는 기본으로 `openai-codex` 한 계정만 쓴다. 한도가 차면 세션이 멈춘다. 이 확장은 `openai-codex`, `openai-codex-account-2`, `openai-codex-account-3` ... 을 하나의 풀로 묶고, 다음을 제공한다:

- **자동 전환, 수동 재개**: `429 / rate limit / quota` 에러에서 실제 소진된 `5시간/7일` 창의 `resetAt`까지 쿨다운을 걸고, 사용 가능한 계정만 골라 `pi.setModel()`로 전환만 한다. 다음 턴은 자동으로 돌리지 않는다. 열려 있는 모든 세션이 동시에 재개되면 새 계정 한도까지 연쇄로 소진되기 때문이다
- **사용량 기록 잠금**: 여러 pi 프로세스가 `codex-account-usage.json`을 동시에 갱신해도 `mkdir` 기반 파일 잠금으로 갱신 유실이 없다
- **한도 시각화**: `/codex-accounts`에서 `https://chatgpt.com/backend-api/wham/usage`를 직접 조회해 `5시간 ███░░ [32% 남음] 리셋 8/28 05:07 (4시간 42분 후) · 7일 █████░░ [49% 남음] 리셋 9/02 20:26 (5일 20시간 후)` 형태로 표시. 절대 날짜 + 남은 시간 함께
- **현재 계정**: 헤더 `│ 현재: go***@naver.com (1번) ●`와 각 줄 `●/○` + `← 현재 사용 중`으로 구분. 목록 진입 전 위젯으로 표를 띄우고 닫으면 자동으로 사라짐 (`setWidget`, `notify` 아님)
- **토큰 카운트**: `~/.pi/agent/codex-account-usage.json`에 계정별 `total / cacheRead`를 5시간 윈도우 기준으로만 누적·리셋. 웹에서 쓴 건 `rate_limit`에는 잡히지만 이 숫자는 pi가 API로 쓴 것만 센다

## Screen

![`/codex-accounts` 실행 화면, 이메일 마스킹](./assets/codex-accounts.png)

## Install

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-codex-accounts
```

`/reload` in pi.

## Usage

1. `/codex-accounts` — 표 확인 후 짧은 선택 메뉴에서 전환
2. 전환은 `5h:15% · 7d:49%` 형태로 `:` 구분, 상세는 위젯 표에서
3. 자동 전환은 설정 없이 동작. 전환 후에는 알림만 띄우고 사용자가 직전 요청을 다시 보내야 이어진다. 모두 소진이면 `모든 Codex 계정이 한도 소진` 알림

계정 추가: `Ctrl+P`에서 `openai-codex-account-3` 선택 → 브라우저 OAuth → 다음 `/codex-accounts`에 3번으로 나타남. 확장은 항상 `가장 높은 번호 +1` 슬롯을 미리 등록한다.

## Notes

- 토큰 표시 `토큰 153M (캐시 149M)`은 이번 5시간 윈도우 누적이며, 윈도우 리셋 시각에 0으로 돌아간다.
- `pi-multicodex` 등 유사 확장이 이미 있다. 이 패키지는 **한국어 UI + 절대 날짜 + 위젯 자동 숨김**에 초점을 둔 가벼운 대체재다.

## License

MIT
