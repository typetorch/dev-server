/**
 * Subscription-only rule: remote-claude runs Claude Code on the dev's Claude subscription (claude.ai login) and never
 * on pay-per-token API billing (an API key, an auth token, Bedrock, Vertex or Foundry).
 *
 *   1. At startup `claude auth status` must report loggedIn, authMethod "claude.ai" and apiProvider "firstParty"
 *      (run with the same scrubbed environment the runs get), or the session refuses to start.
 *   2. Child processes never get ANTHROPIC_* / CLAUDE_CODE_USE_* / AWS_BEARER_TOKEN_BEDROCK (env.ts), and no
 *      --settings or apiKeyHelper is ever passed.
 *   3. Every run checks the stream-json init event: an `apiKeySource` other than "none" kills the run
 *      ("api_billing_refused"). Without the field, the startup check is what vouches for the run.
 */
import { childEnv } from "./env";
import { run } from "./proc";

export const API_BILLING_REFUSED = "api_billing_refused";

export const SUBSCRIPTION_HELP =
	"remote-claude only runs on your Claude subscription; API keys are refused. Run `claude auth login` and sign in with " +
	"your Claude.ai account (Pro, Max, Team or Enterprise), and unset ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN and any " +
	"Bedrock, Vertex or Foundry settings.";

export class SubscriptionRequiredError extends Error {
	override name = "SubscriptionRequiredError";
}

export type AuthVerdict = { ok: true } | { ok: false; reason: string };

/** Judges the output of `claude auth status` (JSON). */
export function assessAuthStatus(stdout: string): AuthVerdict {
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start < 0 || end < start) return { ok: false, reason: "`claude auth status` printed no JSON" };
	let status: Record<string, unknown>;
	try {
		status = JSON.parse(stdout.slice(start, end + 1));
	} catch {
		return { ok: false, reason: "`claude auth status` printed invalid JSON" };
	}
	if (typeof status !== "object" || status === null) return { ok: false, reason: "`claude auth status` printed no object" };
	const show = (value: unknown) => (typeof value === "string" ? `"${value.slice(0, 40)}"` : String(value));
	if (status.loggedIn !== true) return { ok: false, reason: "Claude Code is not logged in" };
	if (status.authMethod !== "claude.ai") return { ok: false, reason: `auth method is ${show(status.authMethod)}, not "claude.ai" (subscription)` };
	if (status.apiProvider !== "firstParty") return { ok: false, reason: `API provider is ${show(status.apiProvider)}, not "firstParty"` };
	return { ok: true };
}

/**
 * Runs `<claude> auth status` with the scrubbed child environment and throws SubscriptionRequiredError unless it
 * reports a claude.ai subscription login.
 */
export async function checkSubscriptionAuth(claude: string[], cwd: string): Promise<void> {
	const result = await run([...claude, "auth", "status"], { cwd, env: childEnv({ forClaude: true }), timeoutMs: 30_000 });
	const verdict = assessAuthStatus(result.stdout);
	if (!verdict.ok) throw new SubscriptionRequiredError(`${verdict.reason}. ${SUBSCRIPTION_HELP}`);
}

/**
 * The per-run check on the stream-json `system`/`init` event: "ok" when the run uses the subscription, "refused" when
 * it would bill an API key (or another source). An init event without `apiKeySource` is accepted only when the startup
 * check passed.
 */
export function judgeInitEvent(event: Record<string, unknown>, subscriptionVerified: boolean): "ok" | "refused" {
	if (!("apiKeySource" in event) || event.apiKeySource === undefined) return subscriptionVerified ? "ok" : "refused";
	return event.apiKeySource === "none" ? "ok" : "refused";
}
