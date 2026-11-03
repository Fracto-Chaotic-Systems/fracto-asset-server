"""Publish audited FluidR3 drum-kit metadata, never audio or playback activation."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
from audit_fluidr3_percussion import COMMIT, SF2_SHA256
from import_fluidr3 import publish_catalog, serialize

ROOT = Path(__file__).resolve().parent.parent / "instruments"
LIBRARY_ID = "fluidr3-percussion"


def coverage_ranges(ranges):
    covered = sorted({v for lo, hi in ranges for v in range(lo, hi + 1)})
    result = []
    for velocity in covered:
        if not result or velocity > result[-1][1] + 1:
            result.append([velocity, velocity])
        else:
            result[-1][1] = velocity
    return result


def extend_catalog(catalog, lock, inventory):
    if lock["commit"] != COMMIT or lock["source"]["sha256"] != SF2_SHA256:
        raise ValueError("Percussion source identity differs from pin")
    candidate = copy.deepcopy(catalog)
    library = {"id": LIBRARY_ID, "name": "FluidR3 percussion", "version": COMMIT,
        "source_format": "sf2", "status": "audited", "license": "MIT",
        "source_url": lock["repository"], "source_revision": COMMIT}
    existing_library = next((item for item in candidate["libraries"] if item["id"] == LIBRARY_ID), None)
    if existing_library and existing_library != library:
        raise ValueError("Existing percussion library differs; refusing to overwrite")
    if not existing_library:
        candidate["libraries"].append(library)
    melodic = next(item for item in candidate["libraries"] if item["id"] == "fluidr3-gm")
    if melodic.get("percussion_library_id", LIBRARY_ID) != LIBRARY_ID:
        raise ValueError("Existing percussion library link differs")
    melodic["percussion_library_id"] = LIBRARY_ID
    kits = []
    for source in inventory["percussion_kits"]:
        key = re.sub(r"[^a-z0-9]+", "-", source["name"].lower()).strip("-")
        groups = [{"source_exclusive_class": group, "midi_notes": sorted({note
            for region in source["regions"] if region["exclusive_class"] == group
            for note in range(region["keys"][0], region["keys"][1] + 1)
            if str(note) in source["coverage"]})} for group in source["exclusive_classes"]]
        kits.append({"id": f"{LIBRARY_ID}-kit-{key}", "library_id": LIBRARY_ID, "kit_key": key,
            "kind": "drum-kit", "name": source["name"], "midi_program": source["program_zero_based"],
            "midi_bank": {"msb": 0, "lsb": 0}, "source_preset": {"bank": 128, "program": source["program_zero_based"]},
            "source_sha256": SF2_SHA256, "enabled": False, "verification_status": "source_audited",
            "coverage_status": "source-audited", "playback_mode": "one-shot",
            "notes": [{"midi_note": int(note), "velocity_ranges": coverage_ranges(value["velocity_ranges"])}
                for note, value in source["coverage"].items()],
            "choke_groups": groups, "recordings": [], "playback_assets": []})
    if len(kits) != 31 or not any(kit["kit_key"] == "standard" and kit["midi_program"] == 0 for kit in kits):
        raise ValueError("Unexpected pinned drum-kit inventory")
    current = [item for item in candidate.get("drum_kits", []) if item["library_id"] == LIBRARY_ID]
    if current and current != kits:
        raise ValueError("Existing drum kits differ; refusing to reset imported or enabled sources")
    candidate["drum_kits"] = [item for item in candidate.get("drum_kits", []) if item["library_id"] != LIBRARY_ID] + kits
    candidate["library_version"] = max(5, candidate["library_version"])
    return candidate


def run(root=ROOT, apply=False):
    original = (root / "catalog.json").read_bytes()
    lock = json.loads((root / LIBRARY_ID / "source-lock.json").read_bytes())
    content = (root / LIBRARY_ID / "kit-inventory.json").read_bytes()
    if hashlib.sha256(content).hexdigest() != lock["inventory"]["sha256"]:
        raise ValueError("Percussion inventory checksum mismatch")
    candidate = serialize(extend_catalog(json.loads(original), lock, json.loads(content)))
    if apply:
        publish_catalog(root, original, candidate)
    result = {"applied": apply, "changed": candidate != original, "drum_kits": 31,
        "enabled_drum_kits": 0, "default_library_id": json.loads(candidate)["default_library_id"],
        "catalog_sha256": hashlib.sha256(candidate).hexdigest()}
    print(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library-dir", type=Path, default=ROOT)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    run(args.library_dir.resolve(), args.apply)
