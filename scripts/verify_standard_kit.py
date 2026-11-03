"""Verify Standard prepared PCM against fresh pinned SF2 renders and source map.
Does not activate or modify the catalog. Native browser checks are separate.
"""
import argparse
import hashlib
import json
from pathlib import Path
import wave
import numpy as np
from audit_fluidr3_percussion import SF2_SHA256
from fluidr3_drum_renderer import FluidRenderer, RATE, BLOCK
from import_fluidr3_percussion import prepare_hit, sha
from prepare_instrument_assets import serialize

ROOT=Path(__file__).resolve().parent.parent/"instruments"
GM_NAMES=["Acoustic Bass Drum","Bass Drum 1","Side Stick","Acoustic Snare","Hand Clap","Electric Snare","Low Floor Tom","Closed Hi-Hat","High Floor Tom","Pedal Hi-Hat","Low Tom","Open Hi-Hat","Low-Mid Tom","Hi-Mid Tom","Crash Cymbal 1","High Tom","Ride Cymbal 1","Chinese Cymbal","Ride Bell","Tambourine","Splash Cymbal","Cowbell","Crash Cymbal 2","Vibraslap","Ride Cymbal 2","Hi Bongo","Low Bongo","Mute Hi Conga","Open Hi Conga","Low Conga","High Timbale","Low Timbale","High Agogo","Low Agogo","Cabasa","Maracas","Short Whistle","Long Whistle","Short Guiro","Long Guiro","Claves","Hi Wood Block","Low Wood Block","Mute Cuica","Open Cuica","Mute Triangle","Open Triangle"]
FAMILIES=["Kick","Kick","Rim","Snr","Clap","Snr","Studio","Hi-Hat Closed","Studio","Hi-Hat Foot","Studio","Hi-Hat Half-Open","Studio","Studio","Crsh 1","Studio","Ride1","China Crash","BellRide","Tambourine","Splash","Cow Bell","Crsh 2","Vibra Slap","Ride2","Bongo Rim","Low Bongo","Closed Slap","High Conga","Low Tumba","High Timbale","Low Timbale","High Agogo","Low Agogo","Cabasa","Maracas","Short Whistle","Long Whistle","Guiro Down","Guiro Up","Clave","High Woodblock","Low Woodblock","Quica Hi","Quica Low","Triangle","Triangle"]


def rms(data):return float(np.sqrt(np.mean(np.asarray(data,dtype=np.float64)**2)))


def source_map(inventory):
    source=next(k for k in inventory["percussion_kits"] if k["program_zero_based"]==0)
    result=[]
    for note,expected,family in zip(range(35,82),GM_NAMES,FAMILIES):
        regions=[r for r in source["regions"] if r["keys"][0]<=note<=r["keys"][1]]
        names=sorted({inventory["referenced_sample_windows"][r["sample_key"]]["name"] for r in regions})
        if not names or not all(family.casefold() in name.casefold() for name in names):
            raise ValueError(f"Unexpected source-map family at note {note}: {names}")
        result.append({"midi_note":note,"gm_name":expected,"source_samples":names,
            "source_instruments":sorted({r["instrument_name"] for r in regions}),"source_family_match":True})
    return result


def source_choke(renderer,closed):
    renderer.check(renderer.silence(renderer.synth,9));renderer.check(renderer.channel(renderer.synth,9,1))
    renderer.check(renderer.select(renderer.synth,9,renderer.sfid,128,0))
    events={0:lambda:renderer.noteon(renderer.synth,9,46,127),4800:lambda:renderer.noteoff(renderer.synth,9,46)}
    if closed:events.update({9600:lambda:renderer.noteon(renderer.synth,9,42,127),14400:lambda:renderer.noteoff(renderer.synth,9,42)})
    cursor=0;parts=[]
    while cursor<2*RATE:
        if cursor in events:events[cursor]()
        next_event=min([f for f in events if f>cursor]+[2*RATE]);count=min(BLOCK,next_event-cursor)
        left=np.empty(count,dtype=np.float32);right=np.empty(count,dtype=np.float32)
        renderer.check(renderer.write(renderer.synth,count,left.ctypes.data,0,1,right.ctypes.data,0,1))
        parts.append(np.column_stack((left,right)));cursor+=count
    return np.concatenate(parts)


def run(root=ROOT,output=None,audition_dir=None):
    audit=root/"fluidr3-percussion";before=(root/"catalog.json").read_bytes();catalog=json.loads(before)
    kit=next(k for k in catalog["drum_kits"] if k["kit_key"]=="standard" and k["library_id"]=="fluidr3-percussion")
    soundfont=audit/"source-cache/FluidR3_GM.sf2"
    if sha(soundfont.read_bytes())!=SF2_SHA256:raise ValueError("SF2 pin mismatch")
    manifest_bytes=(root/kit["rendering"]["manifest_path"]).read_bytes()
    if sha(manifest_bytes)!=kit["rendering"]["manifest_sha256"]:raise ValueError("Render manifest changed")
    manifest=json.loads(manifest_bytes);inventory_bytes=(audit/"kit-inventory.json").read_bytes()
    if sha(inventory_bytes)!=manifest["source_inventory_sha256"]:raise ValueError("Source inventory changed")
    mapping=source_map(json.loads(inventory_bytes))
    renderer=FluidRenderer(audit,soundfont);results=[];audition={};assets={}
    try:
        index=0
        for asset in kit["playback_assets"]:
            content=(root/asset["path"]).read_bytes()
            if sha(content)!=asset["sha256"]:raise ValueError("Prepared chunk checksum mismatch")
            assets[asset["id"]]=asset["sha256"]
            for hit in asset["hits"]:
                rendered=renderer.render(0,hit["midi_note"],hit["render_velocity"])
                pcm,metrics=prepare_hit(rendered)
                expected=content[44+hit["offset_frames"]*2:44+(hit["offset_frames"]+hit["frames"])*2]
                proof=manifest["hits"][index]
                if pcm.tobytes()!=expected or sha(pcm.tobytes())!=hit["pcm_sha256"] or metrics!=proof["metrics"]:
                    raise ValueError(f"Fresh source render differs: {hit['midi_note']}/{hit['render_velocity']}")
                results.append({"midi_note":hit["midi_note"],"velocity_min":hit["velocity_min"],"velocity_max":hit["velocity_max"],
                    "render_velocity":hit["render_velocity"],"duration_seconds":len(pcm)/RATE,"peak":float(np.max(np.abs(pcm.astype(np.float64)/32768))),
                    "rms":rms(pcm.astype(np.float64)/32768),"pcm_sha256":hit["pcm_sha256"],"fresh_source_match":True})
                if hit["velocity_min"]<=100<=hit["velocity_max"]:
                    audition[hit["midi_note"]]=np.rint(pcm.astype(np.float64)*100/hit["render_velocity"]).astype("<i2")
                index+=1
        baseline=source_choke(renderer,False);choked=source_choke(renderer,True)
        baseline_tail=rms(baseline[round(1.3*RATE):round(1.8*RATE)])
        choked_tail=rms(choked[round(1.3*RATE):round(1.8*RATE)])
        if baseline_tail<=1e-6 or choked_tail>=baseline_tail*0.05:raise ValueError("SF2 hi-hat choke reference failed")
    finally:renderer.close()
    clips=[]
    if audition_dir:
        audition_dir.mkdir(parents=True,exist_ok=True);parts=[];cursor=0
        for note in list(range(35,82))+[84]:
            pcm=audition[note];label=GM_NAMES[note-35] if 35<=note<=81 else "Extended note 84 (source bell tree)"
            clips.append({"midi_note":note,"label":label,"start_seconds":cursor/RATE,"duration_seconds":len(pcm)/RATE})
            parts.extend([pcm,np.zeros(round(0.35*RATE),dtype="<i2")]);cursor+=len(pcm)+round(0.35*RATE)
        with wave.open(str(audition_dir/"standard-map-audition.wav"),"wb") as writer:
            writer.setnchannels(1);writer.setsampwidth(2);writer.setframerate(RATE);writer.writeframes(np.concatenate(parts).tobytes())
        (audition_dir/"standard-map-audition.json").write_bytes(serialize(clips))
        for name,data in [("source-open-hat",baseline),("source-choked-hat",choked)]:
            pcm=np.rint(data.mean(axis=1)*32768).clip(-32768,32767).astype("<i2")
            with wave.open(str(audition_dir/(name+".wav")),"wb") as writer:
                writer.setnchannels(1);writer.setsampwidth(2);writer.setframerate(RATE);writer.writeframes(pcm.tobytes())
    if (root/"catalog.json").read_bytes()!=before:raise ValueError("Catalog changed during verification")
    report={"pass":True,"catalog_sha256":sha(before),"kit_id":kit["id"],"source_sha256":SF2_SHA256,
        "renderer_version":renderer.version,"render_manifest_sha256":kit["rendering"]["manifest_sha256"],"assets":assets,
        "fresh_render_hits":len(results),"note_identities":len(kit["notes"]),"gm_core_notes":47,
        "map_evidence":mapping,"hits":results,"source_choke_reference":{"open_hat_tail_rms":baseline_tail,"after_closed_hat_rms":choked_tail,"pass":True},
        "max_hit_seconds":max(h["duration_seconds"] for h in results),"max_peak":max(h["peak"] for h in results),
        "scope":"Fresh pinned-SF2 render equality, source-label GM family mapping and source hi-hat choke reference. No human subjective sound ranking or production drum engine certification.","catalog_changed":False}
    if output:output.write_bytes(serialize(report))
    print(json.dumps({k:v for k,v in report.items() if k not in ("assets","map_evidence","hits")},indent=2),flush=True)
    return report


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--library-dir",type=Path,default=ROOT)
    parser.add_argument("--output",type=Path,default=ROOT/"fluidr3-percussion/standard-source-verification.json")
    parser.add_argument("--audition-dir",type=Path)
    args=parser.parse_args();run(args.library_dir.resolve(),args.output.resolve(),args.audition_dir.resolve() if args.audition_dir else None)
