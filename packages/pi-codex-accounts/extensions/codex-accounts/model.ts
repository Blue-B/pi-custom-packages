// /model은 enabledModels 스코프(공유 별칭 openai-codex)만 보여준다. 계정 별칭에서
// /model로 모델을 고르면 provider가 공유 별칭으로 바뀌며 계정이 1번으로 돌아간다.
// 그 경우에만 원래 계정 별칭을 유지한다. 다른 계정을 직접 고른 건 존중한다.
export function accountToKeep(
	from: string | undefined,
	to: string,
): string | undefined {
	return from && to === "openai-codex" && /^openai-codex-account-\d+$/.test(from)
		? from
		: undefined;
}

// Codex 계정끼리는 모델을 유지한다. 다른 제공자에서 계정을 고른 경우에만
// 대상 계정의 사용 가능한 Codex 모델을 사용한다.
export function modelForAccount<T extends { provider: string }>(
	provider: string,
	current: T | undefined,
	registered: T | undefined,
	available?: T,
): T | undefined {
	if (registered) return registered;
	return current &&
		(current.provider === "openai-codex" ||
			/^openai-codex-account-\d+$/.test(current.provider))
		? { ...current, provider }
		: available;
}
