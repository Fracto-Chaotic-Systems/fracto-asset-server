export const LEGACY_LIBRARY_ID = "legacy";
export const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
export const MAX_LIBRARIES = 16;
export const MAX_INSTRUMENTS = 2048;
const id = (value) =>
  typeof value === "string" &&
  value.length <= 128 &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const label = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

// Additive schema-1 extension. Older single-library catalogs normalize to legacy.
export function catalog_libraries(catalog) {
  if (
    !Array.isArray(catalog.instruments) ||
    catalog.instruments.length > MAX_INSTRUMENTS
  )
    throw new Error("Invalid catalog instrument limit");
  const explicit = catalog.libraries !== undefined;
  const libraries = explicit
    ? catalog.libraries
    : [
        {
          id: LEGACY_LIBRARY_ID,
          name: "Legacy recordings",
          version: "1",
          source_format: "chromatic-mp3",
          status: "active",
        },
      ];
  if (
    !Array.isArray(libraries) ||
    !libraries.length ||
    libraries.length > MAX_LIBRARIES
  )
    throw new Error("Invalid catalog libraries");
  const ids = new Set();
  for (const library of libraries) {
    if (
      !id(library.id) ||
      ids.has(library.id) ||
      !label(library.name) ||
      !label(library.version) ||
      (library.license !== undefined && !label(library.license)) ||
      !["chromatic-mp3", "midi-js-note-mp3", "sf2"].includes(
        library.source_format,
      ) ||
      !["active", "audited"].includes(library.status)
    )
      throw new Error("Invalid or duplicate library");
    if (library.source_url !== undefined) {
      const url = new URL(library.source_url);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      )
        throw new Error("Invalid library source URL");
    }
    if (
      library.source_revision !== undefined &&
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(library.source_revision)
    )
      throw new Error("Invalid library source revision");
    ids.add(library.id);
  }
  for (const library of libraries) {
    if (
      library.percussion_library_id !== undefined &&
      (library.source_format === "sf2" ||
        !id(library.percussion_library_id) ||
        library.percussion_library_id === library.id ||
        !libraries.some(
          (item) =>
            item.id === library.percussion_library_id &&
            item.source_format === "sf2",
        ))
    )
      throw new Error("Unknown or invalid percussion library link");
  }
  const default_library_id = catalog.default_library_id ?? LEGACY_LIBRARY_ID;
  if (
    !ids.has(default_library_id) ||
    libraries.find((item) => item.id === default_library_id).status !== "active"
  )
    throw new Error("Unknown or inactive default library");
  const keys = new Set(),
    instrument_ids = new Set();
  for (const instrument of catalog.instruments) {
    if (instrument.kind === "drum-kit")
      throw new Error("Drum kit must use the drum_kits collection");
    const library_id =
      instrument.library_id ?? (explicit ? null : LEGACY_LIBRARY_ID);
    const instrument_key =
      instrument.instrument_key ??
      (library_id === LEGACY_LIBRARY_ID ? instrument.id : null);
    const library = libraries.find((item) => item.id === library_id);
    if (
      !library ||
      !id(instrument.id) ||
      !id(instrument_key) ||
      instrument_ids.has(instrument.id) ||
      keys.has(`${library_id}/${instrument_key}`) ||
      instrument.id !==
        (library_id === LEGACY_LIBRARY_ID
          ? instrument_key
          : `${library_id}-${instrument_key}`)
    )
      throw new Error("Invalid or duplicate library instrument identity");
    if (library.status !== "active" && instrument.enabled)
      throw new Error("Audited library cannot enable playback");
    keys.add(`${library_id}/${instrument_key}`);
    instrument_ids.add(instrument.id);
  }
  const drum_kits = catalog_drum_kits(catalog, libraries);
  return { libraries, default_library_id, drum_kits };
}

// Activation requires verified bounded assets and an active source library.
export function catalog_drum_kits(catalog, libraries) {
  const kits = catalog.drum_kits === undefined ? [] : catalog.drum_kits;
  if (
    !Array.isArray(kits) ||
    kits.length > 256 ||
    kits.length + catalog.instruments.length > MAX_INSTRUMENTS
  )
    throw new Error("Invalid drum kit inventory limit");
  const ids = new Set(catalog.instruments.map((item) => item.id)),
    programs = new Set();
  for (const kit of kits) {
    const library = libraries.find((item) => item.id === kit.library_id);
    const program_key = `${kit.library_id}/${kit.midi_bank?.msb}/${kit.midi_bank?.lsb}/${kit.midi_program}`;
    if (
      !library ||
      library.source_format !== "sf2" ||
      !id(kit.kit_key) ||
      !id(kit.id) ||
      kit.id !== `${kit.library_id}-kit-${kit.kit_key}` ||
      ids.has(kit.id) ||
      kit.kind !== "drum-kit" ||
      !label(kit.name) ||
      !Number.isInteger(kit.midi_program) ||
      kit.midi_program < 0 ||
      kit.midi_program > 127 ||
      kit.midi_bank?.msb !== 0 ||
      kit.midi_bank?.lsb !== 0 ||
      programs.has(program_key) ||
      kit.source_preset?.bank !== 128 ||
      kit.source_preset?.program !== kit.midi_program ||
      !/^[a-f0-9]{64}$/.test(kit.source_sha256 ?? "") ||
      typeof kit.enabled !== "boolean" ||
      (kit.enabled && (kit.verification_status !== "playback_verified" || library.status !== "active")) ||
      !["source_audited", "assets_prepared", "playback_verified"].includes(
        kit.verification_status,
      ) ||
      kit.coverage_status !== "source-audited" ||
      kit.playback_mode !== "one-shot" ||
      !Array.isArray(kit.recordings) ||
      kit.recordings.length ||
      !Array.isArray(kit.playback_assets)
    )
      throw new Error("Invalid or prematurely enabled drum kit");
    if (
      kit.verification_status === "source_audited" &&
      (kit.playback_assets.length || kit.rendering !== undefined)
    )
      throw new Error("Unprepared kit cannot publish assets");
    ids.add(kit.id);
    programs.add(program_key);
    if (
      !Array.isArray(kit.notes) ||
      !kit.notes.length ||
      kit.notes.length > 128
    )
      throw new Error("Invalid drum note coverage");
    const notes = new Set();
    let previous = -1;
    for (const note of kit.notes) {
      if (
        !Number.isInteger(note.midi_note) ||
        note.midi_note <= previous ||
        note.midi_note > 127 ||
        !Array.isArray(note.velocity_ranges) ||
        !note.velocity_ranges.length ||
        note.velocity_ranges.length > 127
      )
        throw new Error("Invalid drum note mapping");
      previous = note.midi_note;
      notes.add(note.midi_note);
      let last = 0;
      for (const range of note.velocity_ranges) {
        if (
          !Array.isArray(range) ||
          range.length !== 2 ||
          !range.every(Number.isInteger) ||
          range[0] <= last ||
          range[0] < 1 ||
          range[1] < range[0] ||
          range[1] > 127
        )
          throw new Error("Invalid drum velocity coverage");
        last = range[1];
      }
    }
    if (!Array.isArray(kit.choke_groups) || kit.choke_groups.length > 127)
      throw new Error("Invalid drum choke groups");
    const classes = new Set(),
      grouped_notes = new Set();
    for (const group of kit.choke_groups) {
      if (
        !Number.isInteger(group.source_exclusive_class) ||
        group.source_exclusive_class < 1 ||
        group.source_exclusive_class > 127 ||
        classes.has(group.source_exclusive_class) ||
        !Array.isArray(group.midi_notes) ||
        !group.midi_notes.length ||
        group.midi_notes.length > 128
      )
        throw new Error("Invalid drum exclusive class");
      classes.add(group.source_exclusive_class);
      let last = -1;
      for (const note of group.midi_notes) {
        if (!notes.has(note) || note <= last || grouped_notes.has(note))
          throw new Error("Unknown, duplicate or ambiguous choke note");
        grouped_notes.add(note);
        last = note;
      }
    }
    if (
      ["assets_prepared", "playback_verified"].includes(kit.verification_status)
    )
      validate_drum_assets(kit);
  }
  return kits;
}

export function validate_drum_assets(kit) {
  const method = "sf2-drum-hits-pcm16-v1",
    hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const integer = (value) => Number.isSafeInteger(value) && value >= 0;
  const rendering = kit.rendering;
  if (
    !rendering ||
    rendering.method_version !== method ||
    !hash(rendering.config_sha256) ||
    !hash(rendering.renderer_lock_sha256) ||
    typeof rendering.renderer_version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(rendering.renderer_version) ||
    rendering.renderer_version.length > 64 ||
    !kit.playback_assets.length ||
    kit.playback_assets.length > 256
  )
    throw new Error("Invalid drum rendering identity");
  const expected = new Map(
    kit.notes.map((note) => [
      note.midi_note,
      new Set(
        note.velocity_ranges.flatMap(([lo, hi]) =>
          Array.from({ length: hi - lo + 1 }, (_, i) => lo + i),
        ),
      ),
    ]),
  );
  const covered = new Map(kit.notes.map((note) => [note.midi_note, new Set()]));
  let last_note = -1,
    last_velocity = 0;
  for (const [index, asset] of kit.playback_assets.entries()) {
    if (
      asset.id !==
        `${kit.id}-${rendering.config_sha256.slice(0, 12)}-chunk-${index}` ||
      asset.method_version !== method ||
      !hash(asset.sha256) ||
      asset.source_sha256 !== kit.source_sha256 ||
      asset.render_config_sha256 !== rendering.config_sha256 ||
      asset.mime_type !== "audio/wav" ||
      asset.encoding !== "pcm_s16le" ||
      asset.channels !== 1 ||
      asset.sample_rate !== 48000 ||
      !integer(asset.frames) ||
      asset.frames === 0 ||
      asset.frames * 4 > 48 * 1024 * 1024 ||
      asset.decoded_bytes_at_48000 !== asset.frames * 4 ||
      asset.bytes !== 44 + asset.frames * 2 ||
      !Number.isFinite(asset.duration_seconds) ||
      Math.abs(asset.duration_seconds - asset.frames / 48000) > 1e-8 ||
      (asset.path !== undefined &&
        asset.path !== `playback/${kit.id}/${asset.sha256}.wav`) ||
      !Array.isArray(asset.hits) ||
      !asset.hits.length ||
      asset.hits.length > 12
    )
      throw new Error("Invalid bounded drum asset");
    let cursor = 0;
    for (const [hit_index, hit] of asset.hits.entries()) {
      if (
        !expected.has(hit.midi_note) ||
        !integer(hit.velocity_min) ||
        !integer(hit.velocity_max) ||
        hit.velocity_min < 1 ||
        hit.velocity_max > 127 ||
        hit.velocity_min > hit.velocity_max ||
        hit.render_velocity !== hit.velocity_max ||
        hit.midi_note < last_note ||
        (hit.midi_note === last_note && hit.velocity_min <= last_velocity) ||
        !integer(hit.frames) ||
        !hit.frames ||
        hit.frames > 30 * 48000 ||
        !hash(hit.pcm_sha256) ||
        hit.offset_frames !== cursor + (hit_index ? 2400 : 0) ||
        !Number.isFinite(hit.offset_seconds) ||
        !Number.isFinite(hit.duration_seconds) ||
        Math.abs(hit.offset_seconds - hit.offset_frames / 48000) > 1e-8 ||
        Math.abs(hit.duration_seconds - hit.frames / 48000) > 1e-8
      )
        throw new Error("Invalid drum hit mapping");
      for (
        let velocity = hit.velocity_min;
        velocity <= hit.velocity_max;
        velocity++
      ) {
        if (
          !expected.get(hit.midi_note).has(velocity) ||
          covered.get(hit.midi_note).has(velocity)
        )
          throw new Error("Unknown or duplicate drum velocity");
        covered.get(hit.midi_note).add(velocity);
      }
      cursor = hit.offset_frames + hit.frames;
      last_note = hit.midi_note;
      last_velocity = hit.velocity_max;
    }
    if (cursor !== asset.frames) throw new Error("Drum asset bounds mismatch");
  }
  for (const [note, velocities] of expected)
    if (covered.get(note).size !== velocities.size)
      throw new Error("Incomplete drum velocity coverage");
}
