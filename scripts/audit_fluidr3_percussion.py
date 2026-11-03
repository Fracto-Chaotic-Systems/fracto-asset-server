"""Audit pinned original FluidR3 percussion metadata/PCM; never changes runtime catalog.
Offline maintenance only. Uses numpy from instrument-analysis-requirements.txt.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import urllib.request
import numpy as np

ROOT = Path(__file__).resolve().parent.parent / "instruments" / "fluidr3-percussion"
REPOSITORY = "https://github.com/pianobooster/fluid-soundfont"
COMMIT = "24c5c8a82e2f2cec2497710c6a72e5ccfeca40cd"
TREE = "700b2ed1440eb85e6e91a01dc5fc946561e6cf91"
SF2_SIZE = 148398306
SF2_SHA256 = "74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0"
SF2_URL = REPOSITORY + "/releases/download/v3.1/FluidR3_GM.sf2"
NOTICES = {"COPYING": (1086, "b251ece3b10bd8e316dfa44c1c8b689da94bf9db"),
           "README": (1042, "f8bfc859c6abf57eaf45d8d6f6d6d579596bc8f2"),
           "README.md": (632, "b3319f306c5ff0a9e64966b840db067506d3d860")}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def write_json(path, value):
    path.write_bytes((json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))


def read_source(path, url, size, offline):
    if not path.exists():
        if offline:
            raise ValueError("Missing cached source: " + str(path))
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".part")
        # Bounded download; no source code or SoundFont content is executed.
        try:
            with urllib.request.urlopen(url, timeout=60) as response, temporary.open("xb") as output:
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > size:
                        raise ValueError("Source exceeds pinned size")
                    output.write(chunk)
            if temporary.stat().st_size != size:
                raise ValueError("Source size mismatch")
            # Validate before publishing even to the ignored cache.
            content = temporary.read_bytes()
            expected = SF2_SHA256 if path.name == "FluidR3_GM.sf2" else None
            if expected and sha(content) != expected:
                raise ValueError("SF2 checksum mismatch")
            if path.name in NOTICES and blob(content) != NOTICES[path.name][1]:
                raise ValueError("Notice Git blob mismatch")
            temporary.replace(path)
        finally:
            if temporary.exists():
                temporary.unlink()
    content = path.read_bytes()
    if len(content) != size:
        raise ValueError("Source size mismatch")
    return content


def chunks(data, start, end):
    while start < end:
        if start + 8 > end:
            raise ValueError("Truncated RIFF chunk")
        tag, size = struct.unpack_from("<4sI", data, start)
        stop = start + 8 + size
        padded = stop + (size % 2)
        if padded > end:
            raise ValueError("RIFF chunk exceeds container")
        yield tag, memoryview(data)[start + 8:stop]
        start = padded


def tables(data):
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"sfbk":
        raise ValueError("Not a SoundFont RIFF")
    if struct.unpack_from("<I", data, 4)[0] + 8 != len(data):
        raise ValueError("SoundFont length mismatch")
    result = {}
    for tag, payload in chunks(data, 12, len(data)):
        if tag != b"LIST" or len(payload) < 4:
            raise ValueError("Unexpected top-level SoundFont chunk")
        group = bytes(payload[:4]).decode("ascii")
        if group in result:
            raise ValueError("Duplicate SoundFont list")
        result[group] = {}
        for child, value in chunks(payload, 4, len(payload)):
            name = child.decode("ascii")
            if name in result[group]:
                raise ValueError("Duplicate SoundFont table")
            result[group][name] = value
    for required in ("INFO", "sdta", "pdta"):
        if required not in result:
            raise ValueError("Missing SoundFont list")
    return result


def records(content, fmt):
    width = struct.calcsize(fmt)
    if not content or len(content) % width:
        raise ValueError("Invalid SoundFont record table")
    return list(struct.iter_unpack(fmt, content))


def name(value):
    return value.split(b"\0", 1)[0].decode("latin-1")


def zones(headers, bags, generators, selector):
    if headers[-1][1] != len(bags) - 1 or bags[-1][0] != len(generators) - 1:
        raise ValueError("SoundFont terminal indexes mismatch")
    result = []
    for index, (_, begin) in enumerate(headers[:-1]):
        end = headers[index + 1][1]
        if not 0 <= begin <= end < len(bags):
            raise ValueError("Invalid SoundFont bag range")
        global_values = {}
        local = []
        for bag_index in range(begin, end):
            start, stop = bags[bag_index][0], bags[bag_index + 1][0]
            if not 0 <= start <= stop < len(generators):
                raise ValueError("Invalid SoundFont generator range")
            values = {}
            for op, amount in generators[start:stop]:
                if op in values:
                    raise ValueError("Duplicate generator in zone")
                values[op] = amount
            if selector not in values:
                if bag_index != begin:
                    raise ValueError("Noninitial global zone")
                global_values = values
            else:
                local.append({**global_values, **values})
        result.append(local)
    return result


def value_range(generators, op):
    value = generators.get(op, 127 << 8)
    low, high = value & 255, value >> 8
    if not 0 <= low <= high <= 127:
        raise ValueError("Invalid MIDI key/velocity range")
    return low, high


def signed(value):
    return value if value < 32768 else value - 65536


def audit(data):
    lists = tables(data)
    pdta = lists["pdta"]
    phdr = records(pdta["phdr"], "<20sHHHIII")
    inst = records(pdta["inst"], "<20sH")
    shdr = records(pdta["shdr"], "<20sIIIIIBbHH")
    if name(phdr[-1][0]) != "EOP" or name(inst[-1][0]) != "EOI" or name(shdr[-1][0]) != "EOS":
        raise ValueError("Missing SoundFont terminal records")
    presets = zones([(name(h[0]), h[3]) for h in phdr], records(pdta["pbag"], "<HH"), records(pdta["pgen"], "<HH"), 41)
    instruments = zones([(name(h[0]), h[1]) for h in inst], records(pdta["ibag"], "<HH"), records(pdta["igen"], "<HH"), 53)
    pcm = lists["sdta"]["smpl"]
    if len(pcm) % 2:
        raise ValueError("Odd PCM16 sample data")
    samples, kits, seen = {}, [], set()
    for preset_index, h in enumerate(phdr[:-1]):
        if h[2] != 128:
            continue
        if h[1] in seen:
            raise ValueError("Duplicate bank-128 kit program")
        seen.add(h[1])
        regions = []
        for pg in presets[preset_index]:
            iid = pg[41]
            if not 0 <= iid < len(instruments):
                raise ValueError("Invalid instrument reference")
            for ig in instruments[iid]:
                sid = ig[53]
                if not 0 <= sid < len(shdr) - 1:
                    raise ValueError("Invalid sample reference")
                keys = [max(value_range(pg, 43)[0], value_range(ig, 43)[0]), min(value_range(pg, 43)[1], value_range(ig, 43)[1])]
                velocities = [max(1, value_range(pg, 44)[0], value_range(ig, 44)[0]), min(value_range(pg, 44)[1], value_range(ig, 44)[1])]
                if keys[0] > keys[1] or velocities[0] > velocities[1]:
                    continue
                sh = shdr[sid]
                start = sh[1] + signed(ig.get(0, 0)) + 32768 * signed(ig.get(4, 0))
                end = sh[2] + signed(ig.get(1, 0)) + 32768 * signed(ig.get(12, 0))
                if not 0 <= start < end <= len(pcm) // 2 or sh[5] <= 0 or sh[9] & 0x8000:
                    raise ValueError("Invalid or external-ROM sample bounds")
                sample_type = sh[9] & 0x7fff
                if sample_type not in (1, 2, 4, 8):
                    raise ValueError("Unsupported sample type")
                if sample_type != 1:
                    if not 0 <= sh[8] < len(shdr) - 1:
                        raise ValueError("Linked sample reference out of bounds")
                loop_start = sh[3] + signed(ig.get(2, 0)) + 32768 * signed(ig.get(45, 0))
                loop_end = sh[4] + signed(ig.get(3, 0)) + 32768 * signed(ig.get(50, 0))
                if ig.get(54, 0) & 1 and not start <= loop_start < loop_end <= end:
                    raise ValueError("Invalid enabled sample loop")
                key = f"{sid}:{start}:{end}"
                if key not in samples:
                    raw = pcm[start * 2:end * 2]
                    values = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768
                    tail = values[-max(1, sh[5] // 50):]
                    samples[key] = {"sample_id": sid, "name": name(sh[0]), "start_frame": start, "end_frame": end,
                        "sample_rate": sh[5], "duration_seconds": len(values) / sh[5], "root_key": sh[6], "pitch_correction_cents": sh[7],
                        "sample_link": sh[8], "sample_type": sh[9],
                        "linked_pair_reciprocal": sample_type == 1 or shdr[sh[8]][8] == sid, "raw_loop_start": sh[3], "raw_loop_end": sh[4],
                        "pcm_sha256": sha(raw), "peak": float(np.max(np.abs(values))),
                        "rms": float(np.sqrt(np.mean(values * values))), "tail_20ms_rms": float(np.sqrt(np.mean(tail * tail))),
                        "silent": not np.any(values)}
                regions.append({"instrument_id": iid, "instrument_name": name(inst[iid][0]), "sample_key": key,
                    "keys": keys, "velocities": velocities, "effective_loop_frames": [loop_start, loop_end], "exclusive_class": ig.get(57, 0), "sample_modes": ig.get(54, 0),
                    "preset_generators": {str(k): v for k, v in pg.items()}, "instrument_generators": {str(k): v for k, v in ig.items()}})
        coverage = {}
        for note in range(128):
            ranges = [region["velocities"] for region in regions if region["keys"][0] <= note <= region["keys"][1] and not samples[region["sample_key"]]["silent"]]
            covered = sorted({v for lo, hi in ranges for v in range(lo, hi + 1)})
            if covered:
                coverage[str(note)] = {"velocity_ranges": sorted({tuple(pair) for pair in ranges}), "complete_1_127": len(covered) == 127}
        kits.append({"name": name(h[0]), "sf2_bank": 128, "program_zero_based": h[1], "preset_index": preset_index,
            "regions": regions, "coverage": coverage, "gm_35_81_missing": [n for n in range(35, 82) if str(n) not in coverage],
            "exclusive_classes": sorted({r["exclusive_class"] for r in regions if r["exclusive_class"]}),
            "loop_modes": sorted({r["sample_modes"] for r in regions})})
    if not any(kit["program_zero_based"] == 0 for kit in kits):
        raise ValueError("Missing Standard drum kit")
    info = {key: bytes(value).rstrip(b"\0").decode("latin-1") for key, value in lists["INFO"].items() if key != "ifil"}
    version = struct.unpack("<HH", lists["INFO"]["ifil"])
    return {"format_version": list(version), "info": info, "total_presets": len(phdr) - 1,
        "total_samples": len(shdr) - 1, "percussion_kits": sorted(kits, key=lambda k: k["program_zero_based"]),
        "referenced_sample_windows": samples, "pdta_sha256": {key: sha(value) for key, value in pdta.items()},
        "scope": "Structural SF2 zone/key/velocity coverage and raw PCM presence only; not rendered MIDI sound identity, envelope, tail or browser certification. Bank 128 is internal SF2 numbering, not a MIDI CC0 value."}


def run(root=ROOT, offline=False):
    root.mkdir(parents=True, exist_ok=True)
    content = read_source(root / "source-cache" / "FluidR3_GM.sf2", SF2_URL, SF2_SIZE, offline)
    if sha(content) != SF2_SHA256:
        raise ValueError("Pinned SF2 checksum mismatch")
    notices = []
    for filename, (size, git_blob) in NOTICES.items():
        url = f"https://raw.githubusercontent.com/pianobooster/fluid-soundfont/{COMMIT}/{filename}"
        value = read_source(root / "upstream" / filename, url, size, offline)
        if blob(value) != git_blob:
            raise ValueError("Pinned notice Git blob mismatch")
        notices.append({"path": "upstream/" + filename, "url": url, "bytes": size, "git_blob": git_blob, "sha256": sha(value)})
    report = audit(content)
    write_json(root / "kit-inventory.json", report)
    lock = {"schema_version": 1, "status": "audited_not_imported", "repository": REPOSITORY, "commit": COMMIT, "tree": TREE,
        "tag": "v3.1", "release_id": 35191848, "release_asset_id": 29477752, "release_published_at": "2020-12-12T17:59:00Z",
        "source": {"filename": "FluidR3_GM.sf2", "url": SF2_URL, "bytes": SF2_SIZE, "sha256": SF2_SHA256,
                   "git_blob": None, "note": "Release binary is outside the Git tree; commit/tag alone does not pin its bytes. SHA-256 is mandatory."},
        "license": {"id": "MIT", "author": "Frank Wen", "copyright": report["info"].get("ICOP"), "embedded_comment": report["info"].get("ICMT"),
                    "evidence": notices, "relationship_to_melodic_mp3": "Separate distribution and source pin. Does not change the CC-BY declaration retained for existing MIDI.js-rendered samples."},
        "inventory": {"path": "kit-inventory.json", "sha256": sha((root / "kit-inventory.json").read_bytes())},
        "selected_first_kit": {"sf2_bank": 128, "program_zero_based": 0, "name": "Standard"}, "runtime_catalog_changed": False}
    write_json(root / "source-lock.json", lock)
    summary = {"pass": True, "source_sha256": SF2_SHA256, "kit_count": len(report["percussion_kits"]),
        "sample_windows": len(report["referenced_sample_windows"]),
        "nonreciprocal_linked_sample_windows": sum(not value["linked_pair_reciprocal"] for value in report["referenced_sample_windows"].values()),
        "silent_sample_windows": sum(value["silent"] for value in report["referenced_sample_windows"].values()), "standard": next({k: v for k, v in kit.items() if k != "regions"} for kit in report["percussion_kits"] if kit["program_zero_based"] == 0),
        "inventory_sha256": lock["inventory"]["sha256"], "runtime_catalog_changed": False}
    write_json(root / "audit-summary.json", summary)
    print(json.dumps({k: v for k, v in summary.items() if k != "standard"}, indent=2))
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT)
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    run(args.output_dir.resolve(), args.offline)
