export function modelForAccount<T extends { provider: string }>(
	provider: string,
	current: T | undefined,
	registered: T | undefined,
	fallback: T | undefined,
): T | undefined {
	return (
		registered ??
		(current &&
		(current.provider === "openai-codex" ||
			/^openai-codex-account-\d+$/.test(current.provider))
			? { ...current, provider }
			: fallback)
	);
}
