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
      !["chromatic-mp3", "midi-js-note-mp3"].includes(library.source_format) ||
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
  const default_library_id = catalog.default_library_id ?? LEGACY_LIBRARY_ID;
  if (
    !ids.has(default_library_id) ||
    libraries.find((item) => item.id === default_library_id).status !== "active"
  )
    throw new Error("Unknown or inactive default library");
  const keys = new Set(),
    instrument_ids = new Set();
  for (const instrument of catalog.instruments) {
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
  return { libraries, default_library_id };
}
