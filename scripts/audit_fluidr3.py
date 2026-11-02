"""Audit pinned MIDI.js FluidR3_GM data without executing JavaScript.
Requires scripts/instrument-analysis-requirements.txt. Does not alter catalog.json.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import re
import time
import urllib.request
import numpy as np
import soundfile as sf

COMMIT = "044fab8e1456bfafc5776e86dfd6bb8697149aef"
TREE = "4ac0b4d7db835ea68d715d0621186e86d94852cb"
REPOSITORY = "https://github.com/gleitz/midi-js-soundfonts"
ROOT = Path(__file__).resolve().parent.parent / "instruments" / "fluidr3-gm"
MAX_FILE_BYTES = 32 * 1024 * 1024

def digest(data):
    return hashlib.sha256(data).hexdigest()

def blob_hash(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()

def fetch(url, offline=False):
    if offline:
        raise ValueError("Missing cached source in offline mode: " + url)
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "fracto-fluidr3-audit"})
            with urllib.request.urlopen(request, timeout=90) as response:
                data = response.read(MAX_FILE_BYTES + 1)
            if len(data) > MAX_FILE_BYTES:
                raise ValueError("Source exceeds audit file limit")
            return data
        except OSError:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)

def pitch(name):
    match = re.fullmatch(r"([A-G])([#b]?)(-?\d+)", name)
    if not match:
        raise ValueError("Invalid note name: " + name)
    letter, sharp, octave = match.groups()
    value = (int(octave) + 1) * 12 + {"C":0,"D":2,"E":4,"F":5,"G":7,"A":9,"B":11}[letter] + {"":0,"#":1,"b":-1}[sharp]
    if not 0 <= value <= 127:
        raise ValueError("Invalid MIDI pitch")
    return value

def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON property: " + key)
        result[key] = value
    return result

def parse_bundle(content, instrument):
    prefix = ("if (typeof(MIDI) === 'undefined') var MIDI = {};\n"
              "if (typeof(MIDI.Soundfont) === 'undefined') MIDI.Soundfont = {};\n"
              "MIDI.Soundfont." + instrument + " = ")
    text = content.decode("utf-8").strip()
    if not text.startswith(prefix):
        raise ValueError("Unexpected bundle wrapper")
    body = text[len(prefix):].rstrip("; \r\n")
    # Upstream's final property has a trailing comma; audio data cannot contain commas.
    body = re.sub(r",\s*}$", "\n}", body)
    notes = json.loads(body, object_pairs_hook=unique_pairs)
    if not isinstance(notes, dict) or not notes:
        raise ValueError("Empty note data")
    result = {}
    for name, uri in notes.items():
        pitch(name)
        if not isinstance(uri, str) or not uri.startswith("data:audio/mp3;base64,"):
            raise ValueError("Unexpected audio data URI")
        result[name] = base64.b64decode(uri.split(",", 1)[1], validate=True)
    if len({pitch(name) for name in result}) != len(result):
        raise ValueError("Duplicate enharmonic MIDI pitch")
    return result

def verify_blob(data, expected):
    if len(data) != expected["size"] or blob_hash(data) != expected["sha"]:
        raise ValueError("Pinned Git blob mismatch")

def write_json(path, value):
    content = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    path.write_bytes(content.encode("utf-8"))

def run(root, offline=False):
    cache = root / "source-cache" / COMMIT
    cache.mkdir(parents=True, exist_ok=True)
    tree_path = cache / "git-tree.json"
    if not tree_path.exists():
        api = "https://api.github.com/repos/gleitz/midi-js-soundfonts/git/trees/"
        top = json.loads(fetch(api + TREE, offline))
        if top.get("sha") != TREE or top.get("truncated"):
            raise ValueError("Unexpected root tree")
        fluid = next(item for item in top["tree"] if item["path"] == "FluidR3_GM" and item["type"] == "tree")
        subtree = json.loads(fetch(api + fluid["sha"] + "?recursive=1", offline))
        if subtree.get("sha") != fluid["sha"] or subtree.get("truncated"):
            raise ValueError("Unexpected FluidR3 tree")
        entries = [item for item in top["tree"] if item["type"] == "blob"]
        entries.extend({**item, "path":"FluidR3_GM/" + item["path"]} for item in subtree["tree"])
        tree_path.write_text(json.dumps({"sha":TREE,"truncated":False,"tree":entries}),encoding="utf-8")
    tree = json.loads(tree_path.read_bytes())
    if tree.get("sha") != TREE or tree.get("truncated"):
        raise ValueError("Incomplete or unexpected upstream tree")
    blobs = {item["path"]:item for item in tree["tree"] if item["type"] == "blob"}
    def source(path):
        expected = blobs[path]
        target = cache / path
        data = target.read_bytes() if target.exists() else fetch(f"https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/{COMMIT}/{path}", offline)
        verify_blob(data, expected)
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as output:
                output.write(data)
        return data
    docs = {}
    for path in ["README.md", "LICENSE.txt", "FluidR3_GM/names.json"]:
        data = source(path)
        docs[path] = {"git_blob_sha1":blobs[path]["sha"], "sha256":digest(data), "bytes":len(data)}
    names = json.loads(source("FluidR3_GM/names.json"))
    if len(names) != 128 or len(set(names)) != 128 or any(not re.fullmatch(r"[a-z0-9_]+", name) for name in names):
        raise ValueError("Expected 128 unique named GM entries")
    def inspect(pair):
        program, name = pair
        path = f"FluidR3_GM/{name}-mp3.js"
        data = source(path)
        notes = parse_bundle(data, name)
        direct = {Path(key).stem for key in blobs if key.startswith(f"FluidR3_GM/{name}-mp3/")}
        if set(notes) != direct:
            raise ValueError("Bundle/directory note coverage differs: " + name)
        ordered = sorted(notes, key=pitch)
        measurements = []
        for note_name in ordered:
            audio = notes[note_name]
            original = blobs[f"FluidR3_GM/{name}-mp3/{note_name}.mp3"]
            if len(audio) != original["size"] or blob_hash(audio) != original["sha"]:
                raise ValueError("Embedded note differs from raw file: " + name + "/" + note_name)
            info = sf.info(io.BytesIO(audio))
            if info.format != "MP3" or info.frames <= 0 or info.channels not in [1,2]:
                raise ValueError("Unexpected decoded dimensions")
            item = {"name":note_name,"midi_pitch":pitch(note_name),"bytes":len(audio),
                    "sha256":digest(audio),"git_blob_sha1":original["sha"],
                    "sample_rate":info.samplerate,"channels":info.channels,
                    "frames":info.frames,"duration_seconds":info.frames/info.samplerate}
            pcm, rate = sf.read(io.BytesIO(audio), dtype="float32", always_2d=True)
            if len(pcm) != info.frames or rate != info.samplerate or not np.isfinite(pcm).all():
                raise ValueError("Full decode differs from header or contains nonfinite PCM")
            item["decoded_probe"] = {"peak":float(np.max(np.abs(pcm))),
                "rms":float(np.sqrt(np.mean(pcm.astype(np.float64)**2))),
                "last_20ms_rms":float(np.sqrt(np.mean(pcm[-round(rate*.02):].astype(np.float64)**2))),
                "samples_outside_unit_range":int(np.count_nonzero(np.abs(pcm)>1))}
            measurements.append(item)
        print(f"{program+1:03d} {name}: {len(notes)} samples audited", flush=True)
        return {"program_zero_based":program,"program_display":program+1,"name":name,
                "bundle":{"path":path,"bytes":len(data),"sha256":digest(data),"git_blob_sha1":blobs[path]["sha"]},
                "available_packaging":[suffix for suffix in ["mp3.js","ogg.js","mp3.js.gz","ogg.js.gz"] if f"FluidR3_GM/{name}-{suffix}" in blobs],
                "velocity_layers_in_packaging":1,
                "silent_pitches":[note["midi_pitch"] for note in measurements if note["decoded_probe"]["peak"]==0],
                "non_silent_pitches":[note["midi_pitch"] for note in measurements if note["decoded_probe"]["peak"]>0],
                "notes":measurements}
    with ThreadPoolExecutor(max_workers=4) as executor:
        instruments = list(executor.map(inspect, enumerate(names)))
    notes = [note for item in instruments for note in item["notes"]]
    inventory = [{"path":path,"git_blob_sha1":item["sha"],"bytes":item["size"]} for path,item in sorted(blobs.items()) if path.startswith("FluidR3_GM/")]
    manifest = {"schema_version":1,"library_id":"fluidr3-gm","repository":REPOSITORY,"commit":COMMIT,"tree":TREE,
                "commit_date":"2021-12-17T20:51:59Z","audit_method":"static-data-git-blob-and-mp3-readback-v1",
                "license":{"sample_license_as_declared_upstream":"CC-BY-3.0-US","sample_license_url":"https://creativecommons.org/licenses/by/3.0/us/",
                           "software_license":"MIT","software_copyright":"Copyright (C) 2012 Benjamin Gleitzman",
                           "evidence":"README.md distinguishes FluidR3 audio licensing from root LICENSE.txt software licensing."},
                "documents":docs,"inventory":inventory,"instruments":instruments}
    summary = {"pass":True,"commit":COMMIT,"instruments":len(instruments),"embedded_notes":len(notes),
               "fully_decoded_notes":sum("decoded_probe" in note for note in notes),
               "bundle_bytes":sum(item["bundle"]["bytes"] for item in instruments),
               "encoded_note_bytes":sum(note["bytes"] for note in notes),
               "sample_rates":dict(Counter(str(note["sample_rate"]) for note in notes)),
               "channels":dict(Counter(str(note["channels"]) for note in notes)),
               "pitch_min":min(note["midi_pitch"] for note in notes),"pitch_max":max(note["midi_pitch"] for note in notes),
               "duration_min_seconds":min(note["duration_seconds"] for note in notes),
               "duration_max_seconds":max(note["duration_seconds"] for note in notes),
               "notes_per_instrument":sorted(set(len(item["notes"]) for item in instruments)),
               "silent_notes":sum(note["decoded_probe"]["peak"]==0 for note in notes),
               "instruments_with_silent_notes":sum(bool(item["silent_pitches"]) for item in instruments),
               "notes_with_samples_outside_unit_range":sum(note["decoded_probe"]["samples_outside_unit_range"]>0 for note in notes),
               "environment":{"numpy":np.__version__,"soundfile":sf.__version__,"libsndfile":sf.__libsndfile_version__},
               "browser_verification":"not performed; audit only","active_catalog_modified":False}
    root.mkdir(parents=True, exist_ok=True)
    write_json(root/"source-lock.json",manifest)
    summary["source_lock_sha256"] = digest((root/"source-lock.json").read_bytes())
    write_json(root/"audit-summary.json",summary)
    # Retain exact upstream notices independently of the disposable cache.
    notices = root / "upstream"
    notices.mkdir(exist_ok=True)
    for name in ["README.md","LICENSE.txt"]:
        (notices/name).write_bytes(source(name))
    print(json.dumps(summary,indent=2),flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir",type=Path,default=ROOT)
    parser.add_argument("--offline",action="store_true")
    args=parser.parse_args()
    run(args.output_dir.resolve(),args.offline)
