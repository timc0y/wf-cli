import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "wf-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const { ensureConfigDir, readJson, resolveConfigPath, writeJson } = await import("../lib/config.mjs");

describe("shared JSON persistence", () => {
  it("replaces the destination atomically and keeps the private file mode", () => {
    const path = join(dir, "grants.json");
    writeJson(path, { profile: "acme", tier: "read" });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { profile: "acme", tier: "read" });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ["grants.json"]);

    writeJson(path, { profile: "acme", tier: "danger" });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { profile: "acme", tier: "danger" });
    assert.deepEqual(readdirSync(dir), ["grants.json"]);
  });

  it("tightens an existing config directory back to private mode", () => {
    chmodSync(dir, 0o755);
    process.env.WF_CONFIG_DIR = dir;
    ensureConfigDir();
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it("keeps derived paths inside the configured root", () => {
    assert.equal(resolveConfigPath("grants"), join(dir, "grants"));
    assert.throws(() => resolveConfigPath("../outside"), /escapes WF_CONFIG_DIR/);
    assert.throws(() => ensureConfigDir("../outside"), /escapes WF_CONFIG_DIR/);
  });

  it("does not read JSON through a symlinked store file", () => {
    const target = join(dir, "outside.json");
    const link = join(dir, "credentials.json");
    writeJson(target, { token: "should-not-be-read" });
    try {
      symlinkSync(target, link);
      // The symlink guard is unconditional — no option opts out of it.
      assert.deepEqual(readJson(link, { fallback: true }), { fallback: true });
    } finally {
      rmSync(link, { force: true });
    }
  });
});
