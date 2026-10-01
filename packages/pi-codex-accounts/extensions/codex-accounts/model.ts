export function isAccountProvider(provider: string): boolean {
	return provider === "openai" || provider === "openai-account-2";
}

// /model uses shared openai models. Keep account 2 unless an account is explicitly selected.
export function accountToKeep(from: string | undefined, to: string): string | undefined {
	return from === "openai-account-2" && to === "openai" ? from : undefined;
}

export function modelForAccount<T extends { provider: string }>(
	provider: string,
	current: T | undefined,
	registered: T | undefined,
	available?: T,
): T | undefined {
	if (!isAccountProvider(provider)) return undefined;
	if (registered) return registered;
	return current && isAccountProvider(current.provider)
		? { ...current, provider }
		: available;
}
