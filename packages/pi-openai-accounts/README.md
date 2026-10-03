# pi-openai-accounts

공식 OpenAI OAuth 계정 2개를 전환하고, 같은 계정의 Codex 인증으로 실제 플랜 한도를 조회하는 Pi 확장입니다. 모델 요청은 공식 OpenAI 방식으로 유지하며 Codex 인증은 한도 조회에만 사용합니다. Pi 0.99.2 이상이 필요합니다.

이전 이름은 `pi-codex-accounts`입니다. 기존 로컬 설치는 Pi 설정의 패키지 경로를 `packages/pi-openai-accounts`로 바꾼 뒤 `/reload`하세요.

## 설치와 로그인

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-openai-accounts
```

Pi에서 `/reload` 후 다음 두 계정에 로그인합니다.

```text
/login openai
/login openai-account-2
```

두 계정 모두 `Sign in with ChatGPT`를 선택합니다. 기존 Codex 토큰을 Pi에 복사하지 않습니다. 발급된 `clientId`, `scopes`, 기기 ID와 모델 인증 갱신은 Pi의 공식 OAuth 구현을 그대로 사용합니다. 확장은 3번 이후 계정이나 Codex 계정 별칭을 등록하지 않습니다.

계정 전환만 사용할 때는 여기까지 설정하면 됩니다. 한도 그래프도 사용하려면 아래 조회용 인증을 준비하세요.

### 한도 조회용 인증

[Codex CLI](https://developers.openai.com/codex/cli/)가 필요합니다. 설치돼 있지 않다면 다음 명령으로 설치합니다.

```bash
npm install -g @openai/codex
```

Codex에 Pi의 1번과 같은 ChatGPT 계정으로 로그인합니다. 이미 같은 계정의 파일 인증이 `~/.codex/auth.json`에 있으면 이 단계는 생략할 수 있습니다. API 키 인증이나 OS 자격 증명 저장소만 사용하는 경우에는 조회할 파일 인증이 없으므로 아래 방식으로 준비하세요.

```bash
codex -c 'cli_auth_credentials_store="file"' login --device-auth
```

2번은 1번 인증을 덮어쓰지 않도록 다른 폴더에 저장합니다. 승인 화면에서 Pi의 2번과 같은 계정인지 확인하세요.

Linux, macOS, WSL:

```bash
mkdir -p ~/.codex-account-2
CODEX_HOME=~/.codex-account-2 codex -c 'cli_auth_credentials_store="file"' login --device-auth
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME/.codex-account-2" | Out-Null
$previousCodexHome = $env:CODEX_HOME
try {
    $env:CODEX_HOME = "$HOME/.codex-account-2"
    codex -c 'cli_auth_credentials_store="file"' login --device-auth
} finally {
    $env:CODEX_HOME = $previousCodexHome
}
```

명령에 표시된 주소와 일회용 코드로 승인을 완료합니다. 이 최초 로그인에는 브라우저가 필요하지만 이후 한도 조회에는 필요하지 않습니다. 로그인이 끝나면 Pi에서 `/openai-accounts`를 열면 됩니다. 별도 웹 로그인이나 사전 사용량 캐시 없이 서버의 Pi 앱 ID로 계정을 자동 연결합니다. `auth.json`에는 비밀 토큰이 있으므로 Git에 추가하거나 다른 사람에게 보내지 마세요.

## 계정 선택

`/openai-accounts`로 계정 목록을 열고 선택합니다. 현재 계정, 이 확장에서 기록한 누적 토큰, 자동 전환 대기 시간을 표시하며 메뉴를 닫으면 표도 사라집니다. 토큰 기록은 기존 `~/.pi/agent/codex-account-usage.json`을 계속 사용합니다.

`/model`에서 `openai/*` 모델을 골라도 선택한 계정을 유지합니다. 계정만 전환하면 현재 모델을 유지하며, 다른 제공자에서 넘어올 때는 `gpt-6.1-sol`을 기본으로 선택합니다. 계정 별칭을 모델 순환 목록에 넣을 필요는 없습니다.

## 한도 오류 처리

현재 계정의 한도 오류가 발생하면 로그인된 다른 계정으로 전환합니다. Pi가 기본 재시도하는 오류는 Pi에 맡기고, 그렇지 않은 오류는 같은 실패 응답으로 멈춰 있을 때만 한 번 이어갑니다. 새 사용자 요청을 만들거나 과거 작업을 찾아 다시 실행하지 않습니다.

두 계정 모두 실패하면 멈춥니다. 사용자가 취소하거나 새 메시지를 보내거나 세션, 모델, 대화 경로를 바꾸면 예정된 자동 재개를 취소합니다. 같은 사용자 요청은 최대 한 번 자동 재개하며, `/reload` 후에도 대화 기록으로 재개 횟수를 확인합니다.

## 실제 한도 그래프

`/openai-accounts`와 메뉴의 새로고침은 브라우저를 실행하지 않습니다.

기본 조회 인증 폴더는 `~/.codex`(또는 `$CODEX_HOME`)와 `~/.codex-account-2`입니다. 폴더 이름이나 순서로 계정을 추측하지 않습니다. 처음 조회하거나 Pi에 다시 로그인해 앱 ID가 바뀌면, Codex 인증으로 서버의 앱 목록을 읽고 Pi OAuth의 `clientId`와 정확히 일치하는 앱을 찾습니다. 일치하는 계정이 없거나 여러 계정에서 일치하면 연결하지 않고 오류를 표시합니다.

연결이 확인된 뒤에는 같은 계정의 Codex 인증으로 `https://chatgpt.com/backend-api/wham/usage`에 읽기 전용 요청을 보냅니다. 모델 요청은 계속 Pi의 공식 OpenAI OAuth를 사용합니다. 조회는 모델 응답을 생성하지 않습니다. Codex 인증은 복사하거나 자동 갱신하지 않습니다.

이미 다른 인증 폴더를 사용한다면 `OPENAI_ACCOUNTS_CODEX_HOMES`에 경로 구분자(Linux/macOS는 `:`, Windows는 `;`)로 나열할 수 있습니다. 지정한 목록은 기본 조회 폴더를 대체합니다. 확장은 기존 인증 파일만 읽으며 로그인이나 파일 생성을 대신하지 않습니다.

`/openai-accounts web`은 선택적인 웹 진단입니다. 이 명령을 명시적으로 실행할 때만 별도 `ab` 브라우저 CLI로 [공식 사용량 화면](https://chatgpt.com/settings/usage)을 조회합니다. 일반 설정과 한도 조회에는 `ab` 설치나 웹 프로필이 필요하지 않습니다. 웹 진단의 기본 프로필은 `main,work`이며 `OPENAI_ACCOUNTS_USAGE_PROFILES`로 변경할 수 있습니다. 웹 인증은 요청 중 메모리에만 둡니다.

이 기능은 Codex 사용량 조회 경로를 사용합니다. OpenAI 서버의 경로나 접근 정책이 변경되면 조회가 실패할 수 있으며, 실패를 잔여량으로 추정하거나 브라우저를 자동 실행하지 않습니다.

메뉴는 마지막 조회값을 즉시 보여주고, 조회가 끝나면 위쪽 표를 갱신합니다. 계정 전환이나 메뉴 닫기는 조회를 기다리지 않습니다. 플랜 한도만 표시하며 앱별 한도는 표시하지 않습니다. 서버가 반환한 기간과 초기화 시각을 사용하고, 주간 창만 있으면 없는 5시간 창을 만들지 않습니다. 해당 계정의 Codex 인증이 없거나 조회에 실패해도 브라우저를 자동 실행하지 않습니다. `현재 한도 확인 불가`와 이유를 먼저 표시하고, 이전 수치는 `이전 조회 플랜`으로 구별하여 마지막 성공 조회 날짜/시각과 함께 보여줍니다. 갱신 중에도 저장된 숫자는 이전 조회값으로 표시합니다. `~/.pi/agent/openai-account-quota.json`에는 앱 ID별 계정 연결 정보, 한도 수치, 조회 출처와 시각만 저장하며 토큰은 저장하지 않습니다.

누적 토큰은 이 확장이 기록한 사용량이지 구독 할당량이나 잔여량이 아닙니다. 5시간 한도와 주간 한도가 함께 제공되는 계정은 둘 중 하나가 소진돼도 요청이 제한될 수 있습니다.

### 인증 갱신

`Codex 조회 인증 만료 또는 접근 거부`가 표시되면 오류에 나온 인증 폴더의 계정을 확인하고, 위의 로그인 명령을 같은 폴더에서 다시 실행하세요. 인증을 갱신한 후 메뉴에서 새로고침하면 됩니다. Pi 모델 로그인과 조회용 Codex 로그인은 별개이므로 `/login openai-account-2`만 다시 실행해도 Codex 조회 인증은 갱신되지 않습니다.

`동일 계정의 Codex 조회 인증 없음`은 Pi와 Codex 로그인 계정이 다르거나 해당 계정의 인증 파일이 없다는 뜻입니다. `서버의 플랜 한도 수치 없음`이나 HTTP 오류는 수치를 확인하지 못했다는 뜻이며, 사용 한도 소진으로 단정하지 않습니다.

리셋 시각도 알 수 없어 오류 계정은 이 Pi 프로세스에서 1시간 동안 자동 전환 후보에서 제외합니다. 실제 구독 리셋 시각을 뜻하지 않으며, 프로세스를 다시 시작하면 이 대기 상태는 초기화됩니다. 수동 계정 선택은 가능합니다.

## 컨텍스트 설정

모델 컨텍스트와 구독 사용량 한도는 다릅니다. 모델 문서의 총 컨텍스트, 최대 출력, 최대 입력을 구분하고 계정의 실제 허용 범위를 별도로 확인해야 합니다. 예를 들어 총 1,050,000 토큰과 최대 출력 128,000 토큰이면 최대 입력은 922,000 토큰입니다. 로컬 자동 압축을 890,000 토큰에 설정했다면 그보다 먼저 압축합니다. 이 숫자들이 구독 할당량을 늘려 주지는 않습니다.

`models.json`의 `openai.modelOverrides`는 2번 계정 모델에도 적용됩니다. 압축 프로필은 사용 중인 Pi 설정에 맞춰 `openai/modelId`와 `openai-account-2/modelId`를 모두 지정합니다. 확장 자체는 컨텍스트나 압축 설정을 바꾸지 않습니다.

## 검증

저장소 루트에서 실행합니다.

```bash
tsx --test packages/pi-openai-accounts/tests/*.test.ts
```

임시 홈과 가짜 인증, 모델 응답으로 실제 Pi 로더와 세션을 검사합니다. OAuth 로그인 정보 보존과 갱신, API 경로, 모델 정보, 명시적인 계정 전환, 기본 재시도와의 협력, 중복 재개 방지, 취소, 두 계정 소진을 검증합니다. 한도 검사는 빈 사용량 캐시에서의 자동 연결, 뒤바뀐 인증 폴더, 새로운 Pi 앱 ID, 계정 불일치, 중복 매칭 거절, 인증 만료와 복구, 과거 수치의 표시 구분을 포함합니다. 실제 구독 한도를 소비하지 않으며 큰 입력의 서버 허용 범위를 입증하는 검사는 아닙니다.

설치본 검사는 `OPENAI_ACCOUNTS_ENTRY=/절대경로/openai-accounts/index.ts` (기존 `CODEX_ACCOUNTS_ENTRY`도 지원)로 지정할 수 있습니다. 이 확장은 패키지로 설치하고 `~/.pi/agent/extensions/`에 같은 확장의 손 복사본을 두지 않습니다. 이미 열린 Pi에는 `/reload`가 필요합니다. 기존 Codex 모델로 저장된 세션은 새 계정과 모델을 직접 선택해야 합니다.

## License

MIT
