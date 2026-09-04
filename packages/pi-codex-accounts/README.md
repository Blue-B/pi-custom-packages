# pi-codex-accounts

> ChatGPT Codex 멀티 계정 로테이션 + 한도 시각화 for pi. `429`에서 자동 전환, `5시간/7일` 바와 절대 리셋 날짜, 현재 계정 하이라이트.

## Why

Codex는 계정당 `5시간`과 `7일` 윈도우로 할당량을 잰다. pi는 기본으로 `openai-codex` 한 계정만 쓴다. 한도가 차면 세션이 멈춘다. 이 확장은 `openai-codex`, `openai-codex-account-2`, `openai-codex-account-3` ... 을 하나의 풀로 묶고, 다음을 제공한다:

- **자동 순환**: `429 / rate limit / quota` 에러에서 실제 소진된 `5시간/7일` 창의 `resetAt`까지 쿨다운을 걸고, 사용 가능한 계정만 골라 `pi.setModel()` + 숨겨진 `followUp`으로 직전 요청만 재시도
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
3. 자동 순환은 설정 없이 동작. 자동 알림은 사용자 메시지로 위장하지 않고 직전 실제 요청만 재시도하도록 지시한다. 모두 소진이면 `모든 Codex 계정이 한도 소진` 알림

계정 추가: `Ctrl+P`에서 `openai-codex-account-3` 선택 → 브라우저 OAuth → 다음 `/codex-accounts`에 3번으로 나타남. 확장은 항상 `가장 높은 번호 +1` 슬롯을 미리 등록한다.

## Notes

- 토큰 표시 `토큰 153M (캐시 149M)`은 이번 5시간 윈도우 누적이며, 윈도우 리셋 시각에 0으로 돌아간다.
- `pi-multicodex` 등 유사 확장이 이미 있다. 이 패키지는 **한국어 UI + 절대 날짜 + 위젯 자동 숨김**에 초점을 둔 가벼운 대체재다.

## License

MIT
