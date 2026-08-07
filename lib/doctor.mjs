// `wf doctor` — one command that answers "why can't I do the thing?"
//
// WHY: every piece of state that can block a call was already inspectable, but
// only one piece at a time and only by reading a refusal after the fact:
// `wf status` for the profile and grant, `wf token ls` for the store,
// `.wf.json` for the pin, `wf audit fails` for what went wrong last. Diagnosing
// meant knowing which of those to look at, which is exactly the knowledge
// someone stuck does not have.
//
// This runs every check that costs nothing — no network, no grant — and reports
// each as pass / warn / fail with the specific next action. Checks are pure
// functions over injected state so they are testable without touching a real
// config directory or a real network.

import { listErrors } from "./error-codes.mjs";
import { DEFAULT_MAX_CALLS, TIERS } from "./grants.mjs";

const PASS = "pass";
const WARN = "warn";
const FAIL = "fail";
const hasProfile = (profiles, profile) => profiles && typeof profiles === "object" && Object.hasOwn(profiles, profile);

/**
 * Run the offline diagnosis.
 *
 * Everything is injected, so this never reads the filesystem itself.
 *
 * @param {object} state
 * @param {{profile: string|null, source: string}} state.resolved
 * @param {Record<string, object>} state.profiles  name -> profile metadata
 * @param {string|null} state.tokenFingerprint     for the resolved profile
 * @param {object|null} state.grant                the resolved profile's live grant
 * @param {object[]} state.grants                  every live grant
 * @param {{path: string, config: object}|null} state.project
 * @param {object[]} state.recentFailures          audit entries with status >= 400 or 0
 * @param {boolean} state.isTty                    whether stdin+stdout are a TTY
 * @returns {{ checks: object[], ok: boolean, summary: string }}
 */
export const diagnose = ({
  resolved = { profile: null, source: "none" },
  profiles = {},
  tokenFingerprint = null,
  grant = null,
  grants = [],
  project = null,
  recentFailures = [],
  isTty = false
} = {}) => {
  const checks = [];
  const add = (name, status, detail, action = null) => checks.push({ name, status, detail, ...(action ? { action } : {}) });

  // 1. Profile resolution — nothing else can work without it.
  if (resolved.error) {
    add("profile", FAIL, resolved.error, "Use a valid lowercase kebab/underscore profile name (2–41 characters).");
  } else if (!resolved.profile) {
    add(
      "profile",
      FAIL,
      "No workspace profile resolved.",
      "Pass --profile <name>, set WF_PROFILE, or run `wf init` in this project. `wf token ls` lists profiles."
    );
  } else if (!hasProfile(profiles, resolved.profile)) {
    add(
      "profile",
      FAIL,
      `Profile "${resolved.profile}" is configured (via ${resolved.source}) but is not in the token store.`,
      "Either the name is a typo, or a human needs to run `wf token add <profile>`. `wf token ls` shows what exists."
    );
  } else {
    add(
      "profile",
      PASS,
      `"${resolved.profile}" via ${resolved.source}${profiles[resolved.profile].workspaceName ? ` (${profiles[resolved.profile].workspaceName})` : ""}`
    );
  }

  // 2. Token — present, and never shown.
  if (resolved.profile && hasProfile(profiles, resolved.profile)) {
    if (tokenFingerprint) add("token", PASS, `stored (${tokenFingerprint})`);
    else
      add("token", FAIL, "Profile exists but no token is in the store.", "A human must run `wf token add <profile>`. Never handle the token value yourself.");
  }

  // 3. Grant — the actual gate. A missing grant is NORMAL, not broken: access
  // is denied by default, so this is a warn with the ritual, not a failure.
  if (resolved.profile) {
    if (!grant) {
      add(
        "grant",
        WARN,
        "No live grant — network access is denied by default. This is the expected resting state.",
        `Find the site first: \`wf sites\` (free, no grant needed). Then ask the human for the narrowest grant that does the job: wf grant ${resolved.profile} --sites <id> --ttl 15m`
      );
    } else {
      const notes = [`tier ${grant.tier}`];
      if (grant.once) notes.push("single-use (--once: the NEXT call consumes it, even a verification read)");
      if (grant.maxCalls != null) notes.push(`${grant.callsUsed || 0}/${grant.maxCalls} calls used`);
      if (grant.siteIds?.length) notes.push(`sites ${grant.siteIds.join(", ")}`);
      if (grant.scope?.length) notes.push(`scope ${grant.scope.join(", ")}`);
      const nearBudget = grant.maxCalls != null && grant.callsUsed >= grant.maxCalls * 0.8;
      const errors = grant.consecutiveErrors || 0;
      if (nearBudget) {
        add(
          "grant",
          WARN,
          `Live, but near its budget: ${notes.join("; ")}.`,
          "Finish what matters first. If it runs out, STOP and report — do not ask for a fresh grant to retry blindly."
        );
      } else if (errors > 2) {
        add(
          "grant",
          WARN,
          `Live (${notes.join("; ")}) but ${errors} consecutive failures recorded — the breaker revokes it at 10.`,
          "Stop and work out why the calls are failing. Repeating them will lose the grant."
        );
      } else {
        add("grant", PASS, notes.join("; "));
      }
    }
  }

  // 4. Project pin — a pin is the good state; its absence is worth saying out
  // loud, because an unpinned repo will happily target the wrong client.
  if (project?.config?.siteIds?.length) {
    add(
      "site pin",
      PASS,
      `${project.path} pins ${project.config.siteIds.join(", ")}${project.config.siteNames ? ` (${project.config.siteNames.join(", ")})` : ""}`
    );
  } else if (project?.config) {
    add(
      "site pin",
      WARN,
      `${project.path} sets a profile but pins no siteIds — nothing stops a command here targeting another client's site.`,
      "Run `wf init` and pick the site(s) to pin."
    );
  } else {
    add(
      "site pin",
      WARN,
      "No .wf.json in this directory tree — profile must come from --profile or WF_PROFILE, and no site pin applies.",
      "Run `wf init` to pin this project to a profile and site."
    );
  }

  // 5. Grants on OTHER profiles. Not a fault, but a live grant on a client you
  // are not working on is worth seeing.
  const others = grants.filter((g) => g.profile !== resolved.profile);
  if (others.length) {
    add(
      "other grants",
      WARN,
      `${others.length} live grant(s) on other profile(s): ${others.map((g) => `${g.profile} (${g.tier})`).join(", ")}.`,
      "Revoke what you are not using: wf revoke <profile>"
    );
  }

  // 6. TTY — explains why an agent cannot grant, in the place where someone
  // confused about it will look.
  add(
    "grant issuance",
    isTty ? PASS : WARN,
    isTty
      ? "Interactive terminal — you can issue grants here."
      : "Not a TTY, so `wf grant` will refuse here. This is intentional: only a human at a terminal can issue a grant.",
    isTty ? null : "Relay the exact `wf grant …` line to a human and wait."
  );

  // 7. What actually went wrong recently — the question behind most doctor runs.
  if (recentFailures.length) {
    const byCode = {};
    for (const entry of recentFailures) {
      const key = entry.errorCode || `HTTP ${entry.status}`;
      byCode[key] = (byCode[key] || 0) + 1;
    }
    const worst = Object.entries(byCode).sort((a, b) => b[1] - a[1]);
    add(
      "recent failures",
      WARN,
      `${recentFailures.length} failed call(s) in the audit log: ${worst.map(([c, n]) => `${c} ×${n}`).join(", ")}.`,
      "`wf audit fails` for the full text of each."
    );
  } else {
    add("recent failures", PASS, "none in the audit window");
  }

  const failed = checks.filter((c) => c.status === FAIL);
  const warned = checks.filter((c) => c.status === WARN);
  return {
    checks,
    ok: failed.length === 0,
    summary: failed.length
      ? `${failed.length} blocking problem(s), ${warned.length} note(s)`
      : warned.length
        ? `no blocking problems, ${warned.length} note(s)`
        : "all clear"
  };
};

/** Render a diagnosis for a terminal. */
export const formatDiagnosis = ({ checks, summary }) => {
  const icon = { pass: "✓", warn: "!", fail: "✗" };
  const lines = ["wf doctor", ""];
  for (const c of checks) {
    lines.push(`  ${icon[c.status]} ${c.name.padEnd(16)} ${c.detail}`);
    if (c.action) lines.push(`      → ${c.action}`);
  }
  lines.push("", `  ${summary}`);
  return lines.join("\n");
};

/** Reference block: tiers, default budgets, and every error code with its fix. */
export const formatReference = () => {
  const budgets = Object.entries(DEFAULT_MAX_CALLS)
    .map(([tier, n]) => `${tier} ${n ?? "unlimited"}`)
    .join(", ");
  const lines = ["", `  TIERS      ${TIERS.join(" → ")}  (default call budgets: ${budgets})`, "", "  ERROR CODES"];
  for (const { code, meaning, recovery } of listErrors()) {
    lines.push(`    ${code}`);
    lines.push(`      ${meaning}`);
    lines.push(`      → ${recovery}`);
  }
  return lines.join("\n");
};
