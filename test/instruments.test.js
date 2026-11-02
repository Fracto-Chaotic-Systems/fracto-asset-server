import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { seed_library, verify_library } from "../instruments/library.js";

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "fracto-instrument-test-"),
  );
  t.after(() => {
    // Remove only this test's verified absolute temporary directory.
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("fracto-instrument-test-"));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const repo = path.join(root, "source"),
    directory = path.join(root, "library");
  fs.mkdirSync(path.join(repo, "public/audio"), { recursive: true });
  const bytes = Buffer.from([73, 68, 51, 4, 0, 255, 0, 128, 10, 13]);
  fs.writeFileSync(path.join(repo, "public/audio/flute.mp3"), bytes);
  fs.writeFileSync(
    path.join(repo, "public/audio/piano.mp3"),
    Buffer.concat([bytes, Buffer.from([1])]),
  );
  const git = (...args) =>
    execFileSync("git", ["-c", `safe.directory=${repo}`, "-C", repo, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Instrument seed test",
    "-c",
    "user.email=instrument-test@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  const commit = git("rev-parse", "HEAD");
  const definitions = ["flute", "piano"].map((id) => ({
    id,
    name: id,
    kind: "single",
    recordings: [{ filename: `${id}.mp3` }],
  }));
  const options = {
    source_repo: repo,
    directory,
    commit,
    definitions,
    remote: "fixture",
  };
  const catalog_path = path.join(directory, "catalog.json");
  return { options, repo, directory, git, bytes, catalog_path };
}

test("seed preserves binary bytes/provenance, leaves source untouched and reruns idempotently", (t) => {
  const f = fixture(t),
    before = f.git("status", "--porcelain=v1");
  const first = seed_library(f.options);
  assert.equal(first.imported, 2);
  assert.equal(first.integrity_verified, true);
  assert.equal(first.playback_enabled, 0);
  assert.deepEqual(
    fs.readFileSync(path.join(f.directory, "originals/flute.mp3")),
    f.bytes,
  );
  const catalog = JSON.parse(fs.readFileSync(f.catalog_path));
  assert.equal(catalog.provenance.commit, f.options.commit);
  assert.equal(
    catalog.instruments[0].recordings[0].source.git_blob,
    f.git("rev-parse", "HEAD:public/audio/flute.mp3"),
  );
  for (const instrument of catalog.instruments) {
    assert.equal(instrument.enabled, false);
    assert.equal(instrument.pitch_map, null);
    assert.equal(instrument.recordings[0].timing, null);
    assert.equal(instrument.verification_status, "pending");
    assert.deepEqual(instrument.midi_programs, []);
  }
  const original_catalog = fs.readFileSync(f.catalog_path);
  assert.equal(seed_library(f.options).imported, 0);
  assert.deepEqual(fs.readFileSync(f.catalog_path), original_catalog);
  assert.equal(f.git("status", "--porcelain=v1"), before);
});

test("conflicting originals fail preflight without overwriting files or writing a catalog", (t) => {
  const f = fixture(t),
    originals = path.join(f.directory, "originals");
  fs.mkdirSync(originals, { recursive: true });
  fs.writeFileSync(path.join(originals, "piano.mp3"), "existing asset");
  assert.throws(() => seed_library(f.options), /refusing to overwrite piano/);
  assert.equal(
    fs.readFileSync(path.join(originals, "piano.mp3"), "utf8"),
    "existing asset",
  );
  assert.equal(fs.existsSync(path.join(originals, "flute.mp3")), false);
  assert.equal(fs.existsSync(f.catalog_path), false);
});

test("verification fails on tampered or missing recordings and rejects catalog path traversal", (t) => {
  const f = fixture(t);
  seed_library(f.options);
  const target = path.join(f.directory, "originals/flute.mp3");
  fs.writeFileSync(target, Buffer.alloc(f.bytes.length));
  assert.throws(() => verify_library(f.directory), /Integrity check failed/);
  fs.unlinkSync(target);
  assert.throws(() => verify_library(f.directory), /ENOENT/);
  fs.writeFileSync(target, f.bytes);
  const catalog = JSON.parse(fs.readFileSync(f.catalog_path));
  catalog.instruments[0].recordings[0].path = "../outside.mp3";
  fs.writeFileSync(f.catalog_path, JSON.stringify(catalog));
  assert.throws(
    () => verify_library(f.directory),
    /Invalid or duplicate recording/,
  );
});

test("rerun refuses to replace edited catalog metadata", (t) => {
  const f = fixture(t);
  seed_library(f.options);
  const catalog = JSON.parse(fs.readFileSync(f.catalog_path));
  catalog.instruments[0].name = "Edited name";
  fs.writeFileSync(f.catalog_path, JSON.stringify(catalog));
  assert.throws(() => seed_library(f.options), /Existing catalog differs/);
  assert.equal(
    JSON.parse(fs.readFileSync(f.catalog_path)).instruments[0].name,
    "Edited name",
  );
});

test("legacy source recovery preserves added library metadata", (t) => {
  const f = fixture(t);
  seed_library(f.options);
  const catalog = JSON.parse(fs.readFileSync(f.catalog_path));
  catalog.libraries.push({
    id: "fluidr3-gm",
    name: "FluidR3 GM",
    version: "pinned",
    source_format: "midi-js-note-mp3",
    status: "audited",
  });
  fs.writeFileSync(f.catalog_path, JSON.stringify(catalog));
  const before = fs.readFileSync(f.catalog_path);
  seed_library(f.options);
  assert.deepEqual(fs.readFileSync(f.catalog_path), before);
});
