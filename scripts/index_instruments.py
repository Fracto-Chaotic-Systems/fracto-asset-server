"""Reproducible offline analysis of the checksum-pinned instrument originals."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import numpy as np
import soundfile as sf
from instrument_pitch_analysis import METHOD_VERSION, choose_grid, rms_envelope, probe_pitch, note_bounds


def digest(content):
    return hashlib.sha256(content).hexdigest()


def serialize(value):
    return (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")


def analyze_recording(root, recording):
    filename = recording["filename"]
    if Path(filename).name != filename or recording["path"] != "originals/" + filename:
        raise ValueError("Invalid source path")
    source = (root / recording["path"]).resolve()
    if not source.is_relative_to((root / "originals").resolve()):
        raise ValueError("Source escapes originals directory")
    content = source.read_bytes()
    if len(content) != recording["bytes"] or digest(content) != recording["sha256"]:
        raise ValueError(f"Source integrity failed: {filename}")
    del content
    with sf.SoundFile(source) as audio:
        spacing, anchors = choose_grid(audio)
        envelope, hop = rms_envelope(audio)
        duration = len(audio) / audio.samplerate
        notes, excluded = [], []
        for pitch in range(128):
            nominal = spacing * (pitch - 20)
            if nominal < 0 or nominal + 0.3 >= duration:
                excluded.append({"midi_pitch": pitch, "reason": "outside_recording_grid"})
                continue
            proof = probe_pitch(audio, nominal, pitch)
            bounds = note_bounds(envelope, hop, nominal, spacing, duration) if proof else None
            if not proof or not bounds:
                excluded.append({"midi_pitch": pitch, "nominal_seconds": nominal,
                                 "reason": "no_reliable_pitch_evidence" if not proof else "no_reliable_attack"})
                continue
            notes.append({"midi_pitch": pitch, "nominal_seconds": nominal, **bounds, "pitch_evidence": proof})
        if not notes:
            raise ValueError(f"No verified pitch windows: {filename}")
        for previous, current in zip(notes, notes[1:]):
            if previous["end_seconds"] > current["offset_seconds"]:
                raise ValueError(f"Overlapping note windows: {filename}")
        return {
            "schema_version": 1, "method_version": METHOD_VERSION,
            "recording_id": recording["id"], "source_sha256": recording["sha256"],
            "sample_rate": audio.samplerate, "channels": audio.channels,
            "frames": len(audio), "duration_seconds": round(duration, 9),
            "grid": {"slot_seconds": spacing, "zero_pitch": 20,
                     "formula": "slot_seconds * (midi_pitch - zero_pitch)",
                     "verified_anchor_pitches": anchors},
            "measurement": {"rms_hop_seconds": hop, "minimum_matching_windows": 2,
                            "attack_preroll_seconds": 0.02, "tail_padding_seconds": 0.05,
                            "next_slot_guard_seconds": 0.3,
                            "accuracy": "Approximate acoustic onset/tail; browser decode alignment unverified."},
            "notes": notes, "excluded": excluded,
        }


def run(root, apply):
    root = root.resolve()
    catalog_path = root / "catalog.json"
    original_catalog = catalog_path.read_bytes()
    catalog = json.loads(original_catalog)
    reports = []
    summary = []
    for instrument in catalog["instruments"]:
        references, pitch_sets = [], []
        for recording in instrument["recordings"]:
            report = analyze_recording(root, recording)
            body = serialize(report)
            relative = f"indexes/{recording['id']}.json"
            pitches = [note["midi_pitch"] for note in report["notes"]]
            reference = {"recording_id": recording["id"], "path": relative, "sha256": digest(body)}
            references.append(reference)
            pitch_sets.append(set(pitches))
            recording["verification_status"] = "indexing_verified"
            recording["timing"] = {
                "method_version": METHOD_VERSION, "index_path": relative, "index_sha256": digest(body),
                "slot_seconds": report["grid"]["slot_seconds"], "zero_pitch": 20,
                "duration_seconds": report["duration_seconds"], "sample_rate": report["sample_rate"],
                "channels": report["channels"], "available_pitches": pitches,
            }
            reports.append((relative, body))
            row = {"recording_id": recording["id"], "slot_seconds": report["grid"]["slot_seconds"],
                   "count": len(pitches), "min_pitch": min(pitches), "max_pitch": max(pitches),
                   "max_onset_deviation_seconds": round(max(abs(n["onset_deviation_seconds"]) for n in report["notes"]), 6),
                   "guarded_tails": sum(n["tail_guarded"] for n in report["notes"])}
            summary.append(row)
            print(json.dumps(row), flush=True)
        instrument["verification_status"] = "indexing_verified"
        instrument["pitch_map"] = {"type": "recording_indexes", "indexes": references,
                                   "available_pitches": sorted(set.union(*pitch_sets)),
                                   "common_pitches": sorted(set.intersection(*pitch_sets))}
    catalog["library_version"] = 2
    catalog["index_analysis"] = {
        "method_version": METHOD_VERSION,
        "numpy_version": np.__version__, "soundfile_version": sf.__version__,
        "libsndfile_version": sf.__libsndfile_version__,
        "playback_verification": "pending", "recordings": summary,
    }
    if apply:
        if catalog_path.read_bytes() != original_catalog:
            raise ValueError("Catalog changed during analysis; no results applied")
        (root / "indexes").mkdir(exist_ok=True)
        for relative, body in reports:
            (root / relative).write_bytes(body)
        temporary = root / "catalog.json.next"
        with temporary.open("xb") as output:
            output.write(serialize(catalog))
        os.replace(temporary, catalog_path)
    print(json.dumps({"applied": apply, "recordings": len(summary),
                      "verified_windows": sum(row["count"] for row in summary)}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library-dir", type=Path, default=Path(__file__).resolve().parent.parent / "instruments")
    parser.add_argument("--apply", action="store_true", help="Write verified index reports and update catalog")
    args = parser.parse_args()
    try:
        run(args.library_dir, args.apply)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
