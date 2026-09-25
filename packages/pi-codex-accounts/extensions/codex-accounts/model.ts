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

// 계정 전환은 사용자가 고른 모델을 그대로 유지해야 한다. 대상 계정에 같은 모델 ID가
// 있으면 그것을 쓰고, 없으면 현재 모델 객체의 provider만 바꿔서 같은 모델을 유지한다.
// 임의의 다른 모델로 내려가는 폴백은 두지 않는다. 조용히 다른 모델을 호출하면
// 사용자가 더 낮은 모델로 잘못 호출됐는지 알 수 없기 때문이다.
// 유지할 수 없으면 undefined를 반환하고 호출부가 중단한다.
export function modelForAccount<T extends { provider: string }>(
	provider: string,
	current: T | undefined,
	registered: T | undefined,
): T | undefined {
	if (registered) return registered;
	return current &&
		(current.provider === "openai-codex" ||
			/^openai-codex-account-\d+$/.test(current.provider))
		? { ...current, provider }
		: undefined;
}
