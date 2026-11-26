# arrangements

Each subfolder is one arrangement project: a composition's MIDI plus the parts, dynamics and
mix decisions added to turn it into a finished sound track. The folder is the unit of version
control: commit the arranged MIDI, `arrangement.json` and render scripts together so any
revision can be reproduced.

| Folder | Piece | State |
| --- | --- | --- |
| [twelve-note-fugue/](twelve-note-fugue/README.md) | Twelve Note Fugue | v8, work in progress |

Layout of a project folder: `README.md` (index), `source/` (original MIDI, unchanged),
`<Name>.arranged.mid`, `arrangement.json` (schema_version 1), `render/` (offline scripts),
and `variants/` reserved for alternative versions.

These records are not yet read by any service. The intended next step is to surface
arrangements on the All Music page.
