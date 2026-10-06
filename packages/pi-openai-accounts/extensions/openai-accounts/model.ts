// ponytail: temporary legacy Codex OAuth account while Subscription Sharing is broken; remove when openai/openai-account-2 work again.
export const CODEX_ACCOUNT = "openai-account-3";

export function isAccountProvider(provider: string): boolean {
	return provider === "openai" || provider === "openai-account-2" || provider === CODEX_ACCOUNT;
}

// /model uses shared openai models. Keep account 2/3 unless an account is explicitly selected.
export function accountToKeep(from: string | undefined, to: string): string | undefined {
	return (from === "openai-account-2" || from === CODEX_ACCOUNT) && to === "openai" ? from : undefined;
}

export function modelForAccount<T extends { provider: string }>(
	provider: string,
	current: T | undefined,
	registered: T | undefined,
	available?: T,
): T | undefined {
	if (!isAccountProvider(provider)) return undefined;
	if (registered) return registered;
	// Codex models use a different API and base URL, so never copy across the two families.
	return current && isAccountProvider(current.provider) &&
		(current.provider === CODEX_ACCOUNT) === (provider === CODEX_ACCOUNT)
		? { ...current, provider }
		: available;
}
