"""Render audited drum kits into disabled, finite mono PCM16 playback assets.
Default previews by rendering in memory. --apply retains immutable assets and
publishes only after the full Node validator accepts the private candidate.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import numpy as np
from audit_fluidr3_percussion import SF2_SHA256
from fluidr3_drum_renderer import FluidRenderer, CONFIG, RATE
from import_fluidr3 import retain, pcm_wav, publish_catalog, safe_path
from prepare_instrument_assets import serialize, estimated_bytes, MAX_DECODED_BYTES

ROOT = Path(__file__).resolve().parent.parent / "instruments"
METHOD = "sf2-drum-hits-pcm16-v1"
GAP_FRAMES = round(0.05 * RATE)
MAX_HITS = 12


def sha(content): return hashlib.sha256(content).hexdigest()


def velocity_windows(note, source_regions):
    """Refine four tiers at every SF2 zone boundary; never merge across a gap."""
    result=[]
    for low, high in note["velocity_ranges"]:
        edges={low,high+1}
        ranges=CONFIG["velocity_tiers"]+[region["velocities"] for region in source_regions
            if region["keys"][0]<=note["midi_note"]<=region["keys"][1]]
        for a,b in ranges:
            for edge in (a,b+1):
                if low<edge<=high:edges.add(edge)
        ordered=sorted(edges)
        result.extend((a,b-1,b-1) for a,b in zip(ordered,ordered[1:]))
    return result


def prepare_hit(stereo):
    stereo=np.asarray(stereo,dtype=np.float64)
    if stereo.ndim!=2 or stereo.shape[1]!=2 or not len(stereo) or not np.all(np.isfinite(stereo)):
        raise ValueError("Invalid rendered stereo PCM")
    if np.max(np.abs(stereo))>1:raise ValueError("Rendered stereo would clip")
    mono=stereo.mean(axis=1)
    active=np.flatnonzero(np.abs(mono)>CONFIG["quiet_peak"])
    if not len(active):raise ValueError("Stereo downmix is silent")
    start=max(0,int(active[0])-round(CONFIG["pre_roll_seconds"]*RATE))
    end=min(len(mono),int(active[-1])+1+round(CONFIG["retained_quiet_seconds"]*RATE))
    # Renderer must have observed a full quiet tail, not merely reached the cap.
    quiet=round(CONFIG["quiet_seconds"]*RATE)
    if len(stereo)<quiet or np.max(np.abs(stereo[-quiet:]))>CONFIG["quiet_peak"]:
        raise ValueError("Rendered hit has no complete quiet tail")
    signal=mono[start:end].copy()
    fadein=min(len(signal),round(CONFIG["fade_in_seconds"]*RATE))
    fadeout=min(len(signal),round(CONFIG["fade_out_seconds"]*RATE))
    signal[:fadein]*=np.linspace(0,1,fadein)
    signal[-fadeout:]*=np.linspace(1,0,fadeout)
    pcm=np.rint(signal*32768).clip(-32768,32767).astype("<i2")
    if not np.any(pcm):raise ValueError("Quantized drum hit is silent")
    return pcm,{"rendered_frames":len(stereo),"trim_start_frame":start,"trim_end_frame":end,
        "rendered_stereo_sha256":sha(stereo.astype("<f4").tobytes()),
        "stereo_peak":float(np.max(np.abs(stereo))),"mono_peak":float(np.max(np.abs(signal))),
        "quantization_max_error":float(np.max(np.abs(pcm.astype(np.float64)/32768-signal)))}


def pack_hits(hits,kit_id,config_sha):
    batches=[];current=[];frames=0
    for item in hits:
        count=len(item["pcm"])
        if count<=0 or estimated_bytes(count,RATE)>MAX_DECODED_BYTES:
            raise ValueError("Drum hit exceeds bounded decoded budget")
        projected=frames+(GAP_FRAMES if current else 0)+count
        if current and (len(current)>=MAX_HITS or estimated_bytes(projected,RATE)>MAX_DECODED_BYTES):
            batches.append(current);current=[];frames=0
        frames+=(GAP_FRAMES if current else 0)+count;current.append(item)
    if current:batches.append(current)
    result=[]
    for number,batch in enumerate(batches):
        pieces=[];mappings=[];cursor=0
        for item in batch:
            if pieces:pieces.append(np.zeros(GAP_FRAMES,dtype="<i2"));cursor+=GAP_FRAMES
            pcm=item["pcm"]
            mappings.append({"midi_note":item["midi_note"],"velocity_min":item["velocity_min"],"velocity_max":item["velocity_max"],
                "render_velocity":item["render_velocity"],"offset_frames":cursor,"frames":len(pcm),
                "offset_seconds":round(cursor/RATE,9),"duration_seconds":round(len(pcm)/RATE,9),"pcm_sha256":sha(pcm.tobytes())})
            pieces.append(pcm);cursor+=len(pcm)
        content=pcm_wav(np.concatenate(pieces),RATE);digest=sha(content)
        asset={"id":f"{kit_id}-{config_sha[:12]}-chunk-{number}","method_version":METHOD,
            "path":f"playback/{kit_id}/{digest}.wav","sha256":digest,"bytes":len(content),
            "mime_type":"audio/wav","encoding":"pcm_s16le","sample_rate":RATE,"channels":1,"frames":cursor,
            "duration_seconds":round(cursor/RATE,9),"decoded_bytes_at_48000":cursor*4,
            "source_sha256":SF2_SHA256,"render_config_sha256":config_sha,"hits":mappings}
        result.append((asset,content))
    return result


def import_kit(root,audit,kit,source,renderer,apply):
    config_sha=sha(serialize(CONFIG));hits=[]
    for note in kit["notes"]:
        for low,high,velocity in velocity_windows(note,source["regions"]):
            stereo=renderer.render(kit["midi_program"],note["midi_note"],velocity)
            pcm,metrics=prepare_hit(stereo)
            hits.append({"midi_note":note["midi_note"],"velocity_min":low,"velocity_max":high,
                "render_velocity":velocity,"pcm":pcm,"metrics":metrics})
    chunks=pack_hits(hits,kit["id"],config_sha)
    manifest={"schema_version":1,"method_version":METHOD,"kit_id":kit["id"],"source_sha256":SF2_SHA256,
        "source_inventory_sha256":sha((audit/"kit-inventory.json").read_bytes()),
        "renderer_lock_sha256":sha((audit/"renderer-lock.json").read_bytes()),"renderer_version":renderer.version,
        "config":CONFIG,"config_json":serialize(CONFIG).decode("utf-8"),"config_sha256":config_sha,"assets":[a for a,_ in chunks],
        "hits":[{**{k:v for k,v in hit.items() if k!="pcm"},"pcm_sha256":sha(hit["pcm"].tobytes()),"frames":len(hit["pcm"])} for hit in hits],
        "scope":"Prepared offline; audible map, browser playback and kit activation pending."}
    manifest_bytes=serialize(manifest);relative=f"indexes/{kit['id']}-{config_sha[:12]}-render.json"
    new_files=0
    for asset,content in chunks:new_files+=retain(root,asset["path"],content,apply)
    new_files+=retain(root,relative,manifest_bytes,apply)
    candidate=copy.deepcopy(kit)
    candidate.update(enabled=False,verification_status="assets_prepared",playback_assets=[a for a,_ in chunks],
        rendering={"method_version":METHOD,"manifest_path":relative,"manifest_sha256":sha(manifest_bytes),
            "config_sha256":config_sha,"renderer_lock_sha256":manifest["renderer_lock_sha256"],"renderer_version":renderer.version})
    # Only byte-identical verified assets may retain their verification status.
    if kit["verification_status"]=="playback_verified":
        verified=copy.deepcopy(candidate);verified["verification_status"]="playback_verified";verified["enabled"]=kit["enabled"]
        if kit!=verified:raise ValueError("Verified kit differs; refusing to reset verification")
        candidate=verified
    # Never silently reset a future enabled/verified/changed kit.
    if kit["verification_status"]!="source_audited" and kit!=candidate:
        raise ValueError("Prepared kit differs from existing state; refusing to overwrite")
    return candidate,{"kit_id":kit["id"],"hits":len(hits),"chunks":len(chunks),"new_files":new_files,
        "encoded_bytes":sum(a["bytes"] for a,_ in chunks),"largest_decoded_bytes_at_48000":max(a["decoded_bytes_at_48000"] for a,_ in chunks)}


def run(root=ROOT,keys=("standard",),apply=False):
    audit=safe_path(root,"fluidr3-percussion")
    lock=json.loads((audit/"source-lock.json").read_bytes());inventory_bytes=(audit/"kit-inventory.json").read_bytes()
    if lock["source"]["sha256"]!=SF2_SHA256 or sha(inventory_bytes)!=lock["inventory"]["sha256"]:
        raise ValueError("Pinned source/inventory identity mismatch")
    soundfont=safe_path(audit,"source-cache/FluidR3_GM.sf2")
    if sha(soundfont.read_bytes())!=SF2_SHA256:raise ValueError("SF2 checksum mismatch")
    original=(root/"catalog.json").read_bytes();catalog=json.loads(original)
    previous_assets=[asset for kit in catalog["drum_kits"] for asset in kit["playback_assets"]]
    previous_preparation=catalog.get("percussion_preparation",{})
    selected=[kit for kit in catalog["drum_kits"] if kit["library_id"]=="fluidr3-percussion" and ("all" in keys or kit["kit_key"] in keys)]
    if not selected or ("all" not in keys and set(keys)!={kit["kit_key"] for kit in selected}):
        raise ValueError("Unknown or empty kit selection")
    inventory=json.loads(inventory_bytes);sources={kit["program_zero_based"]:kit for kit in inventory["percussion_kits"]}
    renderer=FluidRenderer(audit,soundfont);reports=[];replacements={}
    try:
        for kit in selected:
            candidate,report=import_kit(root,audit,kit,sources[kit["midi_program"]],renderer,apply)
            replacements[kit["id"]]=candidate;reports.append(report);print(json.dumps(report),flush=True)
    finally:renderer.close()
    catalog["drum_kits"]=[replacements.get(kit["id"],kit) for kit in catalog["drum_kits"]]
    catalog["library_version"]=max(6,catalog["library_version"])
    assets=[a for kit in catalog["drum_kits"] for a in kit["playback_assets"]]
    catalog["percussion_preparation"]={"method_version":METHOD,"asset_count":len(assets),"hit_count":sum(len(a["hits"]) for a in assets),
        "encoded_bytes":sum(a["bytes"] for a in assets),"largest_decoded_bytes_at_48000":max(a["decoded_bytes_at_48000"] for a in assets),"browser_verification":previous_preparation.get("browser_verification","pending") if assets==previous_assets else "pending",
        "verified_kit_ids":[kit["id"] for kit in catalog["drum_kits"] if kit["verification_status"]=="playback_verified"]}
    candidate=serialize(catalog)
    if len(candidate)>32*1024*1024:raise ValueError("Prepared catalog exceeds the 32 MiB client/server bound")
    if apply:publish_catalog(root,original,candidate)
    result={"applied":apply,"changed":candidate!=original,"source_sha256":SF2_SHA256,"renderer_version":renderer.version,
        "catalog_sha256":sha(candidate),"kits":reports,"enabled_drum_kits":sum(kit["enabled"] for kit in catalog["drum_kits"]),"browser_verification":catalog["percussion_preparation"]["browser_verification"]}
    if apply:safe_path(audit,"import-report.json").write_bytes(serialize(result))
    print(json.dumps(result,indent=2),flush=True)
    return result


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library-dir",type=Path,default=ROOT)
    parser.add_argument("--kit",action="append",default=None,help="Audited kit key; repeat or use all. Default: standard.")
    parser.add_argument("--apply",action="store_true")
    args=parser.parse_args();run(args.library_dir.resolve(),tuple(args.kit or ["standard"]),args.apply)
