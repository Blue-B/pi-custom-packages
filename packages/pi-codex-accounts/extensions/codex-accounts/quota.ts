export type Window = {
	used_percent?: number;
	reset_at?: number;
	limit_window_seconds?: number;
};

function resetAt(window?: Window): number | undefined {
	if (!window?.reset_at) return undefined;
	return window.reset_at < 10_000_000_000
		? window.reset_at * 1000
		: window.reset_at;
}

export function exhaustedResetAt(...windows: Array<Window | undefined>): number | undefined {
	const resets = windows.flatMap((window) => {
		const reset = resetAt(window);
		return (window?.used_percent ?? 0) >= 100 && reset !== undefined ? [reset] : [];
	});
	return resets.length ? Math.max(...resets) : undefined;
}

export function isAccountAvailable(account: {
	error?: string;
	allowed?: boolean;
	primary?: Window;
	secondary?: Window;
}): boolean {
	return (
		!account.error &&
		(account.allowed === true ||
			(account.allowed === undefined &&
				[account.primary, account.secondary].every(
					(window) =>
						window?.used_percent === undefined || window.used_percent < 100,
				)))
	);
}
