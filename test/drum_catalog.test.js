import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verify_drum_assets } from "../instruments/drum-assets.js";
import { prepared_kit } from "./drum_assets_fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { catalog_libraries } from "../instruments/catalog-libraries.js";
const drum_catalog = () => ({
  schema_version: 1,
  library_version: 5,
  revision: "a".repeat(64),
  default_library_id: "legacy",
  instruments: [],
  libraries: [
    {
      id: "legacy",
      name: "Legacy",
      version: "1",
      source_format: "chromatic-mp3",
      status: "active",
      percussion_library_id: "fluidr3-percussion",
    },
    {
      id: "fluidr3-percussion",
      name: "FluidR3 percussion",
      version: "1",
      source_format: "sf2",
      status: "audited",
      license: "MIT",
    },
  ],
  drum_kits: [
    {
      id: "fluidr3-percussion-kit-standard",
      library_id: "fluidr3-percussion",
      kit_key: "standard",
      kind: "drum-kit",
      name: "Standard",
      midi_program: 0,
      midi_bank: { msb: 0, lsb: 0 },
      source_preset: { bank: 128, program: 0 },
      source_sha256: "b".repeat(64),
      enabled: false,
      verification_status: "source_audited",
      coverage_status: "source-audited",
      playback_mode: "one-shot",
      notes: [35, 42, 44, 46].map((midi_note) => ({
        midi_note,
        velocity_ranges: [[1, 127]],
      })),
      choke_groups: [{ source_exclusive_class: 1, midi_notes: [42, 44, 46] }],
      recordings: [],
      playback_assets: [],
    },
  ],
});

test("only verified kits with bounded assets in an active library can enable playback", () => {
  const catalog = drum_catalog();
  catalog.drum_kits = [prepared_kit(catalog.drum_kits[0]).kit];
  const kit = catalog.drum_kits[0];
  kit.verification_status = "playback_verified";
  kit.enabled = true;
  assert.throws(() => catalog_libraries(catalog));
  catalog.libraries[1].status = "active";
  assert.equal(catalog_libraries(catalog).drum_kits[0].enabled, true);
  kit.verification_status = "assets_prepared";
  assert.throws(() => catalog_libraries(catalog));
});

test("audited drum kits use explicit program, note, velocity and choke identities", () => {
  const catalog = drum_catalog(),
    metadata = catalog_libraries(catalog);
  assert.equal(metadata.drum_kits.length, 1);
  assert.deepEqual(
    metadata.drum_kits[0].choke_groups[0].midi_notes,
    [42, 44, 46],
  );
  assert.equal(metadata.default_library_id, "legacy");
  const old = drum_catalog();
  delete old.drum_kits;
  assert.deepEqual(catalog_libraries(old).drum_kits, []);
});

test("drum catalog rejects ambiguous mappings, premature activation and malformed source identity", () => {
  const cases = [
    (c) => (c.drum_kits = null),
    (c) => (c.drum_kits[0].enabled = true),
    (c) => (c.drum_kits[0].verification_status = "playback_verified"),
    (c) => (c.drum_kits[0].playback_assets = [{}]),
    (c) => (c.drum_kits[0].recordings = [{}]),
    (c) => (c.drum_kits[0].id = "standard"),
    (c) => (c.drum_kits[0].kind = "single"),
    (c) => (c.drum_kits[0].source_sha256 = "bad"),
    (c) => (c.drum_kits[0].midi_bank.msb = 128),
    (c) => (c.drum_kits[0].midi_program = 128),
    (c) => (c.drum_kits[0].source_preset.program = 1),
    (c) => c.drum_kits[0].notes.push(c.drum_kits[0].notes[0]),
    (c) => (c.drum_kits[0].notes[0].midi_note = -1),
    (c) => (c.drum_kits[0].notes[0].velocity_ranges = [[0, 127]]),
    (c) =>
      (c.drum_kits[0].notes[0].velocity_ranges = [
        [1, 90],
        [80, 127],
      ]),
    (c) => (c.drum_kits[0].choke_groups[0].midi_notes = [42, 42]),
    (c) => (c.drum_kits[0].choke_groups[0].midi_notes = [127]),
    (c) =>
      c.drum_kits[0].choke_groups.push({
        source_exclusive_class: 2,
        midi_notes: [42],
      }),
    (c) => {
      const copy = structuredClone(c.drum_kits[0]);
      copy.id = "fluidr3-percussion-kit-other";
      copy.kit_key = "other";
      c.drum_kits.push(copy);
    },
    (c) => (c.libraries[0].percussion_library_id = "missing"),
    (c) => (c.libraries[1].percussion_library_id = "fluidr3-percussion"),
    (c) =>
      c.instruments.push({ ...c.drum_kits[0], instrument_key: "kit-standard" }),
  ];
  for (const mutate of cases) {
    const catalog = drum_catalog();
    mutate(catalog);
    assert.throws(() => catalog_libraries(catalog));
  }
});

test("prepared kits validate bounded hit/velocity mappings while remaining disabled", () => {
  const catalog = drum_catalog();
  catalog.drum_kits = [prepared_kit(catalog.drum_kits[0]).kit];
  assert.equal(
    catalog_libraries(catalog).drum_kits[0].verification_status,
    "assets_prepared",
  );
  for (const mutate of [
    (k) => (k.enabled = true),
    (k) => k.playback_assets[0].frames++,
    (k) => (k.playback_assets[0].source_sha256 = "0".repeat(64)),
    (k) => (k.playback_assets[0].hits[0].velocity_min = 2),
    (k) => (k.playback_assets[0].hits[0].render_velocity = 10),
    (k) => (k.playback_assets[0].hits[0].offset_frames = 1),
    (k) => (k.playback_assets[0].hits[0].frames = 30 * 48000 + 1),
    (k) => (k.playback_assets[0].hits[1].midi_note = 35),
    (k) => k.playback_assets[0].hits.pop(),
    (k) => (k.rendering.config_sha256 = "bad"),
  ]) {
    const copy = structuredClone(catalog);
    mutate(copy.drum_kits[0]);
    assert.throws(() => catalog_libraries(copy));
  }
});

test("drum verifier checks manifests, hit PCM, quiet gaps and faded edges", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fracto-drums-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("fracto-drums-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (relative, content) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  for (const options of [
    {},
    { bad_gap: true },
    { silent: true },
    { bad_edge: true },
  ]) {
    const catalog = drum_catalog(),
      fixture = prepared_kit(catalog.drum_kits[0], options);
    catalog.drum_kits = [fixture.kit];
    catalog.percussion_preparation = fixture.totals;
    write(fixture.kit.playback_assets[0].path, fixture.content);
    write(fixture.kit.rendering.manifest_path, fixture.manifest_bytes);
    if (Object.keys(options).length)
      assert.throws(() => verify_drum_assets(root, catalog));
    else {
      const result = verify_drum_assets(root, catalog);
      assert.equal(result.drum_hit_windows, 4);
      assert.equal(result.prepared_drum_kits, 1);
      fs.appendFileSync(
        path.join(root, fixture.kit.rendering.manifest_path),
        " ",
      );
      assert.throws(() => verify_drum_assets(root, catalog));
    }
  }
});

test("verified drum assets retain disabled metadata until engine integration", () => {
  const catalog = drum_catalog(),
    kit = prepared_kit(catalog.drum_kits[0]).kit;
  kit.verification_status = "playback_verified";
  catalog.drum_kits = [kit];
  assert.equal(catalog_libraries(catalog).drum_kits[0].enabled, false);
  kit.enabled = true;
  assert.throws(() => catalog_libraries(catalog));
});
