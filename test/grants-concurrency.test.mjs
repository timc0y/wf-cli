import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-grants-concurrency-"));
  process.env.WF_CONFIG_DIR = dir;
  process.env.WF_NO_KEYCHAIN = "1";
});
after(() => rmSync(dir, { recursive: true, force: true }));

const grants = await import("../lib/grants.mjs");
const grantsUrl = new URL("../lib/grants.mjs", import.meta.url).href;
const SITE_A = "aaaaaaaaaaaaaaaaaaaaaaaa";

const startAuthorizeChild = () => {
  const script = `
    const grants = await import(${JSON.stringify(grantsUrl)});
    process.send({ type: "ready" });
    await new Promise((resolve) => process.once("message", (message) => message === "go" && resolve()));
    try {
      const result = grants.authorize({ profile: "acme", method: "GET", path: ${JSON.stringify(`sites/${SITE_A}/pages`)} });
      process.send({ type: "done", result });
    } catch (error) {
      process.send({ type: "error", error: { message: error.message, code: error.code } });
      process.exitCode = 1;
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, WF_CONFIG_DIR: dir, WF_NO_KEYCHAIN: "1" },
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });

  let readySeen = false;
  let doneSeen = false;
  let readyResolve;
  let readyReject;
  let doneResolve;
  let doneReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const done = new Promise((resolve, reject) => {
    doneResolve = resolve;
    doneReject = reject;
  });
  child.on("message", (message) => {
    if (message?.type === "ready") {
      readySeen = true;
      readyResolve();
    } else if (message?.type === "done") {
      doneSeen = true;
      doneResolve(message.result);
    } else if (message?.type === "error") {
      doneSeen = true;
      doneReject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    }
  });
  child.on("error", (error) => {
    if (!readySeen) readyReject(error);
    if (!doneSeen) doneReject(error);
  });
  child.on("close", (code) => {
    if (!readySeen) readyReject(new Error(`authorize child exited before ready (${code})`));
    if (!doneSeen) doneReject(new Error(`authorize child exited before result (${code})`));
  });
  return { child, ready, done };
};

describe("grant store concurrency", () => {
  it("waits for a competing process instead of authorizing outside the transaction", async () => {
    grants.revokeAll();
    grants.issueGrant({ profile: "acme", tier: "read", ttlMs: 60_000, maxCalls: 1, siteIds: [SITE_A] });

    const lockPath = join(dir, "grants.lock");
    writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: "test-holder" })}\n`, { mode: 0o600 });
    const worker = startAuthorizeChild();

    try {
      await worker.ready;
      worker.child.send("go");

      const completedBeforeRelease = await Promise.race([worker.done.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 200))]);
      assert.equal(completedBeforeRelease, false, "authorization bypassed the store lock");

      unlinkSync(lockPath);
      const result = await worker.done;
      assert.equal(result.ok, true);
      assert.equal(result.grant.callsUsed, 1);
      assert.equal(grants.getGrant("acme").callsUsed, 1);
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {}
      if (worker.child.exitCode === null) worker.child.kill("SIGTERM");
      await worker.done.catch(() => {});
    }
  });
});
