# Immutable game releases

Each child key contains content-addressed release directories produced by the
asset service publisher. Commit/deploy these complete directories together.
`manifest.json` declares the scene, calibration, resource hashes and NOTICE.txt.
Playback reads only these files; source catalogs and authoring databases are not
needed. Do not edit a release in place: publish a new one and update the consumer's
release binding. Motion descriptions remain independently owned by their consumer.
