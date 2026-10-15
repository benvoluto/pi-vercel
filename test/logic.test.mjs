// Unit tests for the production / destructive / blocked gating logic.
//
// Run with:  npm test   (or:  node test/logic.test.mjs)
//
// The extension imports host-provided packages (@earendil-works/*, typebox)
// that live inside the pi installation, so we locate the newest pi release and
// alias those imports to it, then import the TypeScript extension via jiti.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = join(here, "..", "extensions", "vercel", "index.ts");

// --- Locate the pi installation's node_modules -----------------------------
function findPiNodeModules() {
	const override = process.env.PI_NODE_MODULES;
	if (override && existsSync(override)) return override;
	const releases = join(homedir(), ".pi", "agent", "install", "releases");
	if (!existsSync(releases)) return null;
	const versions = readdirSync(releases)
		.filter((v) => existsSync(join(releases, v, "node_modules", "jiti")))
		.sort()
		.reverse();
	return versions.length ? join(releases, versions[0], "node_modules") : null;
}

const nm = findPiNodeModules();
if (!nm) {
	console.error(
		"Could not find the pi installation's node_modules. Set PI_NODE_MODULES to the directory that contains jiti, @earendil-works/*, and typebox.",
	);
	process.exit(2);
}

const { createJiti } = await import(pathToFileURL(join(nm, "jiti", "lib", "jiti.mjs")).href);

const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": join(nm, "@earendil-works", "pi-coding-agent"),
		"@earendil-works/pi-tui": join(nm, "@earendil-works", "pi-tui"),
		typebox: join(nm, "typebox", "build", "index.mjs"),
	},
});

const mod = await jiti.import(extensionPath);
const { isDestructive, isProductionDeploy, BLOCKED_SUBCOMMANDS } = mod;

let pass = 0;
let fail = 0;
function check(name, got, want) {
	const ok = got === want;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (got ${got}, want ${want})`);
	ok ? pass++ : fail++;
}

// --- isProductionDeploy ---
check("deploy --prod is prod", isProductionDeploy(["deploy", "--prod"]), true);
check("deploy --production is prod", isProductionDeploy(["deploy", "--production"]), true);
check("deploy --target=production is prod", isProductionDeploy(["deploy", "--target=production"]), true);
check("bare deploy is NOT prod", isProductionDeploy(["deploy"]), false);
check("implicit deploy (my-app) not prod", isProductionDeploy(["my-app"]), false);
check("implicit deploy --prod is prod", isProductionDeploy(["my-app", "--prod"]), true);
check("list is not prod", isProductionDeploy(["list"]), false);

// --- isDestructive ---
check("rm is destructive", isDestructive(["rm", "dep123"]), true);
check("remove is destructive", isDestructive(["remove", "dep123"]), true);
check("rollback is destructive", isDestructive(["rollback"]), true);
check("promote is destructive", isDestructive(["promote", "dep"]), true);
check("redeploy is destructive", isDestructive(["redeploy", "dep"]), true);
check("alias is destructive", isDestructive(["alias", "set", "a", "b"]), true);
check("logout is destructive", isDestructive(["logout"]), true);
check("env rm is destructive", isDestructive(["env", "rm", "FOO"]), true);
check("env ls is NOT destructive", isDestructive(["env", "ls"]), false);
check("env pull is NOT destructive", isDestructive(["env", "pull"]), false);
check("project rm is destructive", isDestructive(["project", "rm", "x"]), true);
check("project ls is NOT destructive", isDestructive(["project", "ls"]), false);
check("domains rm is destructive", isDestructive(["domains", "rm", "x.com"]), true);
check("domains ls is NOT destructive", isDestructive(["domains", "ls"]), false);
check("deploy --prod is destructive", isDestructive(["deploy", "--prod"]), true);
check("bare deploy NOT destructive", isDestructive(["deploy"]), false);
check("list NOT destructive", isDestructive(["list"]), false);
check("whoami NOT destructive", isDestructive(["whoami"]), false);
check("inspect NOT destructive", isDestructive(["inspect", "url"]), false);

// --- blocked set ---
check("login blocked", BLOCKED_SUBCOMMANDS.has("login"), true);
check("dev blocked", BLOCKED_SUBCOMMANDS.has("dev"), true);
check("signup blocked", BLOCKED_SUBCOMMANDS.has("signup"), true);
check("deploy NOT blocked", BLOCKED_SUBCOMMANDS.has("deploy"), false);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
