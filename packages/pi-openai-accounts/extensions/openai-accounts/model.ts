export function isAccountProvider(provider: string): boolean {
	return provider === "openai";
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
