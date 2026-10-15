/**
 * Vercel Extension for Pi
 * ------------------------
 * Brings the Vercel "plugin for coding agents" experience to Pi:
 *
 *   1. Registers the hosted Vercel MCP server (https://mcp.vercel.com) so the
 *      model can query projects, deployments, docs, logs and more. The server
 *      uses OAuth — run `/mcp login vercel` (or just use it and approve the
 *      browser prompt) the first time.
 *
 *   2. Exposes a model-callable `vercel` tool that runs the Vercel CLI safely
 *      (argument array, no shell), with truncated output and confirmation for
 *      destructive / production operations.
 *
 *   3. Adds convenience slash commands: `/vercel`, `/vercel-login`,
 *      `/vercel-whoami`, `/vercel-deploy`, `/vercel-logs`, `/vercel-list`,
 *      `/vercel-env`, `/vercel-link`, `/vercel-open`.
 *
 * Config via environment variables (all optional):
 *   PI_VERCEL_MCP=0            disable registering the hosted MCP server
 *   PI_VERCEL_MCP_EXPOSURE=... exposure for MCP tools (direct|codemode|deferred|hidden)
 *   PI_VERCEL_MCP_URL=...      override the MCP endpoint
 *   PI_VERCEL_BIN=...          path to the vercel binary (default: `vercel` on PATH)
 *
 * Install: `pi install git:github.com/<you>/pi-vercel` (or a local path), then
 * authenticate the MCP server with `/mcp login vercel` inside a session and the
 * CLI with `vercel login`. See README.md.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VERCEL_BIN = process.env.PI_VERCEL_BIN || "vercel";
const MCP_URL = process.env.PI_VERCEL_MCP_URL || "https://mcp.vercel.com";
// Register the hosted Vercel MCP server for the session (zero-config). Set
// PI_VERCEL_MCP=0 to disable, e.g. if you prefer to define it in mcp.json so
// that shell `pi mcp login vercel` and non-TUI /mcp can also see it.
const MCP_ENABLED = process.env.PI_VERCEL_MCP !== "0";
const MCP_EXPOSURE = (process.env.PI_VERCEL_MCP_EXPOSURE || "direct") as
	| "direct"
	| "codemode"
	| "deferred"
	| "hidden";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // deploys can be slow

// Subcommands that take over the terminal / run forever — not for the tool.
export const BLOCKED_SUBCOMMANDS = new Set(["login", "dev", "signup"]);

// First-token subcommands that change or remove remote state.
export const DESTRUCTIVE_SUBCOMMANDS = new Set([
	"remove",
	"rm",
	"rollback",
	"promote",
	"redeploy",
	"alias",
	"ln",
	"certs",
	"dns",
	"domains",
	"logout",
]);

// Flags that force a production/live deployment.
export function isProductionDeploy(args: string[]): boolean {
	const first = args[0];
	const deployish = first === "deploy" || first === "redeploy" || !first?.startsWith("-");
	if (!deployish) return false;
	return args.some(
		(a) => a === "--prod" || a === "--production" || a === "--target=production" || a === "production",
	);
}

export function isDestructive(args: string[]): boolean {
	const first = (args[0] || "").toLowerCase();
	if (DESTRUCTIVE_SUBCOMMANDS.has(first)) {
		// env/project/domains sub-actions are only destructive on rm/remove
		if ((first === "domains" || first === "dns" || first === "certs") && !args.some((a) => /^(rm|remove)$/i.test(a))) {
			return false;
		}
		return true;
	}
	if (first === "env" && args.some((a) => /^(rm|remove)$/i.test(a))) return true;
	if (first === "project" && args.some((a) => /^(rm|remove)$/i.test(a))) return true;
	return isProductionDeploy(args);
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

function runVercel(args: string[], cwd: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(VERCEL_BIN, args, {
			cwd,
			env: { ...process.env, VERCEL_TELEMETRY_DISABLED: "1", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000);
		}, timeoutMs);

		const onAbort = () => {
			child.kill("SIGTERM");
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", (err: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (err.code === "ENOENT") {
				reject(
					new Error(
						`Could not find the Vercel CLI ("${VERCEL_BIN}"). Install it with \`npm i -g vercel\` or set PI_VERCEL_BIN.`,
					),
				);
			} else {
				reject(err);
			}
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}

interface VercelDetails {
	args: string[];
	exitCode: number | null;
	timedOut: boolean;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

async function formatOutput(
	args: string[],
	res: RunResult,
): Promise<{ text: string; details: VercelDetails }> {
	const combined = [res.stdout, res.stderr].filter(Boolean).join("\n").trim() || "(no output)";
	const truncation = truncateHead(combined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

	const details: VercelDetails = { args, exitCode: res.code, timedOut: res.timedOut };
	let text = `$ vercel ${args.join(" ")}\n\n${truncation.content}`;

	if (truncation.truncated) {
		const dir = await mkdtemp(join(tmpdir(), "pi-vercel-"));
		const file = join(dir, "output.txt");
		await writeFile(file, combined, "utf8");
		details.truncation = truncation;
		details.fullOutputPath = file;
		text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
			truncation.outputBytes,
		)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${file}]`;
	}

	if (res.timedOut) text += `\n\n[Command timed out and was terminated.]`;
	text += `\n\n[exit code: ${res.code}]`;
	return { text, details };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const Params = Type.Object({
	args: Type.Array(Type.String(), {
		description:
			"Vercel CLI arguments as an array, e.g. [\"list\"], [\"deploy\",\"--prod\"], " +
			"[\"logs\",\"<url>\"], [\"env\",\"ls\"]. Do NOT include the leading \"vercel\". " +
			"Interactive commands (login, dev, signup) are not allowed here.",
	}),
	timeout_seconds: Type.Optional(
		Type.Number({ description: "Max seconds to wait (default 300). Increase for long deploys." }),
	),
});

export default function vercelExtension(pi: ExtensionAPI) {
	// --- 1. Hosted MCP server -------------------------------------------------
	if (MCP_ENABLED) {
		try {
			pi.registerMcpServer("vercel", {
				url: MCP_URL,
				exposure: MCP_EXPOSURE,
				description:
					"Vercel: inspect projects, deployments, environment variables, logs, and search Vercel docs.",
			});
		} catch (err) {
			// A user-level mcp.json entry named "vercel" takes precedence; that's fine.
			console.error(`[vercel] MCP registration skipped: ${(err as Error).message}`);
		}
	}

	// --- 2. Model-callable CLI tool ------------------------------------------
	pi.registerTool({
		name: "vercel",
		label: "Vercel CLI",
		description:
			"Run the Vercel CLI for deployment and project operations. Provide `args` as an array " +
			"(without the leading `vercel`). Useful commands: `deploy` / `deploy --prod`, `list`, " +
			"`inspect <url>`, `logs <url>`, `env ls|pull`, `promote`, `rollback`, `redeploy`, " +
			"`alias`, `domains`, `project ls`, `link`, `pull`, `whoami`. Production and destructive " +
			"operations ask for confirmation when a UI is available. Prefer the Vercel MCP tools for " +
			"read-only queries when they are available.",
		parameters: Params,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const args = params.args.map(String);
			if (args.length === 0) throw new Error("No Vercel CLI arguments provided.");

			const first = args[0].toLowerCase();
			if (BLOCKED_SUBCOMMANDS.has(first)) {
				throw new Error(
					`\`vercel ${first}\` is interactive/long-running and cannot run through this tool. ` +
						(first === "login"
							? "Use the /vercel-login command or run `vercel login` in a terminal."
							: "Run it directly in a terminal."),
				);
			}

			// Confirm production / destructive operations when a UI is present.
			if (ctx.hasUI && isDestructive(args)) {
				const label = isProductionDeploy(args) ? "production deployment" : "destructive Vercel operation";
				const ok = await ctx.ui.confirm(`Allow ${label}?`, `vercel ${args.join(" ")}`);
				if (!ok) {
					return {
						content: [{ type: "text", text: `User declined: vercel ${args.join(" ")}` }],
						details: { args, exitCode: null, timedOut: false } as VercelDetails,
						isError: true,
					};
				}
			}

			const timeoutMs = Math.max(1, params.timeout_seconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
			const res = await runVercel(args, ctx.cwd, signal, timeoutMs);
			const { text, details } = await formatOutput(args, res);

			return {
				content: [{ type: "text", text }],
				details,
				isError: res.code !== 0 && res.code !== null,
			};
		},

		renderCall(args, theme) {
			const list = Array.isArray(args?.args) ? (args.args as string[]) : [];
			let text = theme.fg("toolTitle", theme.bold("vercel "));
			text += theme.fg("accent", list.join(" "));
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as VercelDetails | undefined;
			const ok = !result.isError;
			let text = ok
				? theme.fg("success", `✓ vercel ${details?.args?.join(" ") ?? ""}`)
				: theme.fg("error", `✗ vercel ${details?.args?.join(" ") ?? ""} (exit ${details?.exitCode})`);
			if (details?.timedOut) text += theme.fg("warning", " (timed out)");
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					for (const line of content.text.split("\n").slice(0, 40)) {
						text += `\n${theme.fg("dim", line)}`;
					}
				}
			}
			return new Text(text, 0, 0);
		},
	});

	// --- 3. Convenience slash commands ---------------------------------------
	// A passthrough command plus a few shortcuts. They run the CLI and feed the
	// output to the model as a user message so it can act on the result.

	async function runCommandAndReport(
		rawArgs: string,
		ctx: ExtensionCommandContext,
		extra: string[] = [],
	) {
		const parsed = rawArgs.trim().length ? rawArgs.trim().split(/\s+/) : [];
		const args = [...extra, ...parsed];
		if (args.length === 0) {
			ctx.ui.notify("Usage: provide a Vercel subcommand, e.g. /vercel list", "info");
			return;
		}
		ctx.ui.notify(`Running: vercel ${args.join(" ")}`, "info");
		try {
			const res = await runVercel(args, ctx.cwd, ctx.signal, DEFAULT_TIMEOUT_MS);
			const { text } = await formatOutput(args, res);
			await pi.sendUserMessage(
				`I ran a Vercel command. Here is the output:\n\n\`\`\`\n${text}\n\`\`\``,
			);
		} catch (err) {
			ctx.ui.notify((err as Error).message, "error");
		}
	}

	pi.registerCommand("vercel", {
		description: "Run any Vercel CLI command (e.g. /vercel list)",
		handler: (args, ctx) => runCommandAndReport(args, ctx),
	});

	pi.registerCommand("vercel-whoami", {
		description: "Show the logged-in Vercel user",
		handler: (_a, ctx) => runCommandAndReport("", ctx, ["whoami"]),
	});

	pi.registerCommand("vercel-list", {
		description: "List recent deployments",
		handler: (args, ctx) => runCommandAndReport(args, ctx, ["list"]),
	});

	pi.registerCommand("vercel-deploy", {
		description: "Deploy the current project (append --prod for production)",
		handler: (args, ctx) => runCommandAndReport(args, ctx, ["deploy"]),
	});

	pi.registerCommand("vercel-logs", {
		description: "Show deployment logs (optionally pass a deployment URL/id)",
		handler: (args, ctx) => runCommandAndReport(args, ctx, ["logs"]),
	});

	pi.registerCommand("vercel-env", {
		description: "Manage environment variables (e.g. /vercel-env ls)",
		handler: (args, ctx) => runCommandAndReport(args.trim() ? args : "ls", ctx, ["env"]),
	});

	pi.registerCommand("vercel-link", {
		description: "Link the current directory to a Vercel project",
		handler: (args, ctx) => runCommandAndReport(args, ctx, ["link"]),
	});

	pi.registerCommand("vercel-open", {
		description: "Open the current project in the Vercel dashboard",
		handler: (_a, ctx) => runCommandAndReport("", ctx, ["open"]),
	});

	// Login is interactive — run it detached so the browser flow can complete.
	pi.registerCommand("vercel-login", {
		description: "Log in to Vercel (opens a browser)",
		handler: async (_a, ctx) => {
			ctx.ui.notify("Launching `vercel login` — complete the flow in your browser.", "info");
			const child = spawn(VERCEL_BIN, ["login"], {
				cwd: ctx.cwd,
				env: { ...process.env, VERCEL_TELEMETRY_DISABLED: "1" },
				stdio: "ignore",
				detached: true,
			});
			child.on("error", (err) => ctx.ui.notify(`login failed: ${(err as Error).message}`, "error"));
			child.unref();
		},
	});
}
