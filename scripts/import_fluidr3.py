"""Import pinned FluidR3 note data into disabled, bounded mono playback assets.
Default is read-only preview. --apply writes immutable files and atomically publishes
only after the Node source/index/playback verifier accepts a candidate catalog.
"""
import argparse
import copy
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import wave
import numpy as np
import soundfile as sf
from audit_fluidr3 import COMMIT, TREE, REPOSITORY, parse_bundle, blob_hash, fetch, pitch
from prepare_instrument_assets import (serialize, plan_chunks, render_chunk,
    validate_pcm, estimated_bytes, METHOD_VERSION)

ROOT = Path(__file__).resolve().parent.parent / "instruments"
INDEX_METHOD = "fluidr3-note-samples-v1"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(root, relative):
    root = root.resolve()
    target = root / relative
    if not target.resolve().is_relative_to(root):
        raise ValueError("Output path escapes library")
    current = root
    for part in Path(relative).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Symbolic links are not import storage")
    return target


def retain(root, relative, data, apply):
    target = safe_path(root, relative)
    if target.exists():
        if not target.is_file() or target.stat().st_size != len(data) or sha(target.read_bytes()) != sha(data):
            raise ValueError("Conflicting immutable import file: " + relative)
        return False
    if apply:
        target.parent.mkdir(parents=True, exist_ok=True)
        safe_path(root, relative)
        with target.open("xb") as output:
            output.write(data)
    return True


def pcm_wav(pcm, rate):
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(pcm.astype("<i2").tobytes())
    return output.getvalue()


def canonical_source(decoded):
    """Downmix without fades/normalization; preserve original full sample boundaries."""
    parts, notes, excluded = [], [], []
    cursor, largest_error, rate = 0, 0., None
    for original, samples, sample_rate in decoded:
        if rate is None:
            rate = sample_rate
        if sample_rate != rate or len(samples) != original["frames"] or samples.shape[1] != original["channels"] or not np.isfinite(samples).all():
            raise ValueError("Decoded note dimensions or values differ from audit")
        peak = float(np.max(np.abs(samples)))
        if (peak == 0) != (original["decoded_probe"]["peak"] == 0):
            raise ValueError("Decoded silence differs from source audit")
        if peak == 0:
            excluded.append({"midi_pitch":original["midi_pitch"],"reason":"silent_source","source_sha256":original["sha256"]})
            continue
        mono = samples.astype(np.float64).mean(axis=1)
        if np.max(np.abs(mono)) > 1:
            raise ValueError("Mono source would clip")
        pcm = np.rint(mono * 32768).clip(-32768,32767).astype("<i2")
        if not np.any(pcm):
            raise ValueError("Non-silent stereo source vanished in mono downmix")
        largest_error = max(largest_error, float(np.max(np.abs(mono-pcm.astype(np.float64)/32768))))
        onset = int(np.flatnonzero(np.abs(pcm.astype(np.int32)) >= max(1, float(np.max(np.abs(pcm.astype(np.int32))))*.0001))[0])
        start = max(0, onset-round(.02*rate))
        end = cursor+len(pcm)
        notes.append({"midi_pitch":original["midi_pitch"],
            "raw_start_frame":cursor,"raw_end_frame":end,
            "nominal_seconds":round(cursor/rate,9),
            "offset_seconds":round((cursor+start)/rate,9),
            "onset_seconds":round((cursor+onset)/rate,9),
            "tail_end_seconds":round(end/rate,9),"end_seconds":round(end/rate,9),
            "duration_seconds":round((len(pcm)-start)/rate,9),"tail_guarded":False,
            "source_sample":{"name":original["name"],"sha256":original["sha256"],"frames":original["frames"],"sample_rate":sample_rate,"channels":original["channels"]}})
        parts.append(pcm)
        cursor = end
    if not parts:
        raise ValueError("Instrument has no usable notes")
    return pcm_wav(np.concatenate(parts), rate), notes, excluded, rate, cursor, largest_error


def decode_notes(entry, bundle):
    notes = parse_bundle(bundle, entry["name"])
    expected = {note["name"]:note for note in entry["notes"]}
    if set(notes) != set(expected):
        raise ValueError("Bundle keys differ from audit")
    for name in sorted(notes, key=pitch):
        data, original = notes[name], expected[name]
        if len(data) != original["bytes"] or sha(data) != original["sha256"] or blob_hash(data) != original["git_blob_sha1"]:
            raise ValueError("Encoded note differs from source lock")
        samples, rate = sf.read(io.BytesIO(data),dtype="float32",always_2d=True)
        if rate != original["sample_rate"]:
            raise ValueError("Unexpected sample rate")
        yield original, samples, rate


def prepare_instrument(root, entry, bundle, apply):
    key = re.sub("_+", "-", entry["name"])
    identifier = "fluidr3-gm-" + key
    recording_id = identifier + "-" + COMMIT[:8] + "-main"
    source, notes, excluded, rate, frames, error = canonical_source(decode_notes(entry,bundle))
    recording = {"id":recording_id,"filename":recording_id+".wav",
        "path":"originals/"+recording_id+".wav","mime_type":"audio/wav",
        "bytes":len(source),"sha256":sha(source),"velocity_layer":None,
        "verification_status":"indexing_verified",
        "source":{"kind":"midi-js-note-mp3","repository":REPOSITORY,"commit":COMMIT,
                  "path":entry["bundle"]["path"],"git_blob":entry["bundle"]["git_blob_sha1"],
                  "bundle_sha256":entry["bundle"]["sha256"],"conversion":"stereo arithmetic mean to PCM16; no normalization"}}
    index = {"schema_version":1,"method_version":INDEX_METHOD,"recording_id":recording_id,
        "source_sha256":recording["sha256"],"bundle_sha256":entry["bundle"]["sha256"],
        "sample_rate":rate,"channels":1,"frames":frames,"duration_seconds":round(frames/rate,9),
        "notes":notes,"excluded":excluded}
    index_data = serialize(index)
    index_path = "indexes/"+recording_id+".json"
    pitches = [note["midi_pitch"] for note in notes]
    recording["timing"] = {"method_version":INDEX_METHOD,"index_path":index_path,"index_sha256":sha(index_data),
        "sample_rate":rate,"channels":1,"frames":frames,"duration_seconds":index["duration_seconds"],"available_pitches":pitches}
    generated = int(retain(root,recording["path"],source,apply))+int(retain(root,index_path,index_data,apply))
    assets=[]
    with sf.SoundFile(io.BytesIO(source)) as audio:
        for number, chunk in enumerate(plan_chunks(notes,rate)):
            content, mappings, peak = render_chunk(audio,chunk)
            validate_pcm(content,mappings,rate)
            digest = sha(content)
            path = f"playback/{recording_id}/{digest}.wav"
            generated += int(retain(root,path,content,apply))
            count = mappings[-1]["offset_frames"]+mappings[-1]["frames"]
            assets.append({"id":f"{recording_id}-chunk-{number}","recording_id":recording_id,
                "velocity_layer":None,"path":path,"sha256":digest,"bytes":len(content),
                "mime_type":"audio/wav","encoding":"pcm_s16le","sample_rate":rate,"channels":1,
                "frames":count,"duration_seconds":round(count/rate,9),
                "decoded_bytes_at_48000":estimated_bytes(count,rate),"method_version":METHOD_VERSION,
                "source_sha256":recording["sha256"],"index_sha256":sha(index_data),"peak_before_fade":peak,"notes":mappings})
    instrument = {"id":identifier,"library_id":"fluidr3-gm","instrument_key":key,
        "name":entry["name"].replace("_"," ").title(),"kind":"single","enabled":False,
        "verification_status":"assets_prepared","midi_programs":[entry["program_zero_based"]],
        "banks":[{"msb":0,"lsb":0}],"recordings":[recording],"playback_assets":assets,
        "pitch_map":{"type":"recording_indexes","indexes":[{"recording_id":recording_id,"path":index_path,"sha256":sha(index_data)}],"available_pitches":pitches,"common_pitches":pitches}}
    return instrument, {"id":identifier,"notes":len(notes),"excluded":len(excluded),"chunks":len(assets),
        "source_bytes":len(source),"playback_bytes":sum(asset["bytes"] for asset in assets),
        "source_quantization_max_error":error,"new_files":generated}


def publish_catalog(root, original, candidate):
    temporary=safe_path(root,f"catalog.fluidr3-{os.getpid()}.next.json")
    with temporary.open("xb") as output:
        output.write(candidate)
    try:
        subprocess.run(["node",str(Path(__file__).resolve().parent/"instruments.js"),"verify","--library-dir",str(root),"--catalog-file",str(temporary)],check=True)
        if safe_path(root,"catalog.json").read_bytes()!=original:
            raise ValueError("Catalog changed during import; not publishing")
        if candidate!=original:
            os.replace(temporary,safe_path(root,"catalog.json"))
        else:
            temporary.unlink()
    except Exception:
        # Only this invocation's private candidate; never delete audio/library data.
        if temporary.exists(): temporary.unlink()
        raise


def run(root, audit, apply=False, offline=False, workers=4):
    root, audit = root.resolve(), audit.resolve()
    original = safe_path(root,"catalog.json").read_bytes()
    catalog = json.loads(original)
    lock_data = (audit/"source-lock.json").read_bytes()
    summary = json.loads((audit/"audit-summary.json").read_bytes())
    lock = json.loads(lock_data)
    if sha(lock_data) != summary["source_lock_sha256"] or lock["commit"] != COMMIT or lock["tree"] != TREE or len(lock["instruments"]) != 128:
        raise ValueError("Invalid pinned source lock")
    library = next(item for item in catalog["libraries"] if item["id"] == "fluidr3-gm")
    if library["source_revision"] != COMMIT or library["source_format"] != "midi-js-note-mp3":
        raise ValueError("Catalog source identity differs from audit")
    old = {item["id"]:item for item in catalog["instruments"] if item.get("library_id")=="fluidr3-gm"}
    def import_entry(entry):
        expected=entry["bundle"]
        path=safe_path(audit,"source-cache/"+COMMIT+"/"+expected["path"])
        if path.exists() and path.stat().st_size != expected["bytes"]:
            raise ValueError("Pinned source bundle size mismatch")
        bundle=path.read_bytes() if path.exists() else fetch(f"https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/{COMMIT}/{expected['path']}",offline)
        if len(bundle)!=expected["bytes"] or sha(bundle)!=expected["sha256"] or blob_hash(bundle)!=expected["git_blob_sha1"]:
            raise ValueError("Pinned source bundle mismatch")
        if not path.exists() and apply:
            retain(audit,"source-cache/"+COMMIT+"/"+expected["path"],bundle,True)
        instrument,report=prepare_instrument(root,entry,bundle,apply)
        previous=copy.deepcopy(old.get(instrument["id"]))
        if previous:
            enabled,status=previous.pop("enabled"),previous.pop("verification_status")
            proposed={k:v for k,v in instrument.items() if k not in ["enabled","verification_status"]}
            if previous!=proposed:
                raise ValueError("Existing FluidR3 instrument differs; use a new versioned source")
            instrument.update(enabled=enabled,verification_status=status)
        return instrument,report
    keys=[re.sub("_+","-",entry["name"]) for entry in lock["instruments"]]
    if len(set(keys))!=128:
        raise ValueError("Source instrument identity collision")
    imported,reports=[],[]
    with ThreadPoolExecutor(max_workers=workers) as executor:
        try:
            for instrument,report in executor.map(import_entry,lock["instruments"]):
                imported.append(instrument);reports.append(report)
                print(json.dumps(report),flush=True)
        except Exception:
            executor.shutdown(wait=True,cancel_futures=True)
            raise
    if len({item["id"] for item in imported})!=128:
        raise ValueError("Instrument identity collision")
    catalog["instruments"]=[item for item in catalog["instruments"] if item.get("library_id")!="fluidr3-gm"]+imported
    catalog["library_version"]=max(4,catalog["library_version"])
    library["status"]="active"
    all_assets=[asset for item in catalog["instruments"] for asset in item["playback_assets"]]
    catalog["playback_preparation"].update(asset_count=len(all_assets),note_count=sum(len(a["notes"]) for a in all_assets),
        encoded_bytes=sum(a["bytes"] for a in all_assets),largest_decoded_bytes_at_48000=max(a["decoded_bytes_at_48000"] for a in all_assets),
        browser_verification=(catalog["playback_preparation"].get("browser_verification", "pending") if old else "partial_legacy_verified_fluidr3_pending"))
    candidate=serialize(catalog)
    if len(candidate)>32*1024*1024:
        raise ValueError("Candidate catalog exceeds runtime byte limit")
    result={"applied":apply,"source_commit":COMMIT,"source_lock_sha256":sha(lock_data),
        "instruments":len(imported),"notes":sum(i["notes"] for i in reports),"excluded_silent_notes":sum(i["excluded"] for i in reports),
        "chunks":sum(i["chunks"] for i in reports),"source_bytes":sum(i["source_bytes"] for i in reports),
        "playback_bytes":sum(i["playback_bytes"] for i in reports),"new_files":sum(i["new_files"] for i in reports),
        "source_quantization_max_error":max(i["source_quantization_max_error"] for i in reports),
        "catalog_bytes":len(candidate),"fluidr3_enabled":sum(i["enabled"] for i in imported),
        "browser_verification":"pending","instruments_report":reports}
    if apply:
        publish_catalog(root, original, candidate)
        safe_path(audit,"import-report.json").write_bytes(serialize(result))
    print(json.dumps({k:v for k,v in result.items() if k!="instruments_report"},indent=2),flush=True)
    return result


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library-dir",type=Path,default=ROOT)
    parser.add_argument("--audit-dir",type=Path,default=ROOT/"fluidr3-gm")
    parser.add_argument("--apply",action="store_true")
    parser.add_argument("--offline",action="store_true")
    parser.add_argument("--workers",type=int,choices=[1,2,3,4],default=4)
    args=parser.parse_args()
    run(args.library_dir,args.audit_dir,args.apply,args.offline,args.workers)
