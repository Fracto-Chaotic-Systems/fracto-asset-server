"""Pinned FluidSynth C API wrapper for offline percussion rendering only."""
import ctypes as ct
import hashlib
import json
import os
from pathlib import Path
import numpy as np

VERSION = "2.6.2"
ARCHIVE_SHA256 = "808295345d43c9c428f3fa87d29fbf97a9926f356df95559ff2689f3bd4072d7"
RATE = 48000
BLOCK = 256
CONFIG = {"method_version":"sf2-drum-hits-pcm16-v1", "sample_rate": RATE,
    "gain":0.2,"interpolation":7,"reverb":False,"chorus":False,"cpu_cores":1,
    "note_off_seconds":0.1,"max_hit_seconds":30,"quiet_seconds":0.2,
    "quiet_peak":1/65536,"min_hit_seconds":0.3,"pre_roll_seconds":0.002,
    "retained_quiet_seconds":0.02,"fade_in_seconds":0.0005,"fade_out_seconds":0.005,
    "velocity_tiers":[[1,31],[32,63],[64,95],[96,127]],
    "velocity_representative":"upper bound of each intersection with source velocity regions",
    "output":"arithmetic stereo average, mono PCM16, no per-hit normalization"}


def digest(content): return hashlib.sha256(content).hexdigest()


class FluidRenderer:
    def __init__(self, root, soundfont):
        if os.name != "nt" or ct.sizeof(ct.c_void_p) != 8:
            raise ValueError("This renderer pin requires 64-bit Windows; other platforms need their own verified renderer pin")
        root=Path(root).resolve()
        lock=json.loads((root/"renderer-lock.json").read_bytes())
        if lock["version"]!=VERSION or lock["archive"]["sha256"]!=ARCHIVE_SHA256:
            raise ValueError("Unrecognized renderer pin")
        directory=root/"source-cache/renderer"
        archive=(directory/"renderer.zip").read_bytes()
        if digest(archive)!=ARCHIVE_SHA256:
            raise ValueError("Renderer archive checksum mismatch")
        import io,zipfile
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            if {m.filename for m in zipped.infolist() if not m.is_dir()} != {m["path"] for m in lock["files"]}:
                raise ValueError("Renderer lock does not cover the complete archive")
            for member in lock["files"]:
                target=directory/member["path"]
                if not target.resolve().is_relative_to(directory.resolve()) or target.is_symlink():
                    raise ValueError("Unsafe renderer cache path")
                content=target.read_bytes()
                if len(content)!=member["bytes"] or digest(content)!=member["sha256"] or content!=zipped.read(member["path"]):
                    raise ValueError("Pinned renderer file differs")
        dll=directory/f"fluidsynth-v{VERSION}-win10-x64-cpp11/bin/libfluidsynth-3.dll"
        self.dll_directory=os.add_dll_directory(str(dll.parent))
        self.api=ct.CDLL(str(dll))
        self.settings=None;self.synth=None
        def bind(name,result,args):
            fn=getattr(self.api,name);fn.restype=result;fn.argtypes=args;return fn
        ptr=ct.c_void_p;integer=ct.c_int;string=ct.c_char_p
        self.version=bind("fluid_version_str",string,[])().decode()
        if self.version!=VERSION: raise ValueError("Renderer version differs")
        self.new_settings=bind("new_fluid_settings",ptr,[])
        self.del_settings=bind("delete_fluid_settings",None,[ptr])
        self.setint=bind("fluid_settings_setint",integer,[ptr,string,integer])
        self.setnum=bind("fluid_settings_setnum",integer,[ptr,string,ct.c_double])
        self.new_synth=bind("new_fluid_synth",ptr,[ptr])
        self.del_synth=bind("delete_fluid_synth",None,[ptr])
        self.sfload=bind("fluid_synth_sfload",integer,[ptr,string,integer])
        self.select=bind("fluid_synth_program_select",integer,[ptr,integer,integer,integer,integer])
        self.channel=bind("fluid_synth_set_channel_type",integer,[ptr,integer,integer])
        self.interp=bind("fluid_synth_set_interp_method",integer,[ptr,integer,integer])
        self.noteon=bind("fluid_synth_noteon",integer,[ptr,integer,integer,integer])
        self.noteoff=bind("fluid_synth_noteoff",integer,[ptr,integer,integer])
        self.silence=bind("fluid_synth_all_sounds_off",integer,[ptr,integer])
        self.write=bind("fluid_synth_write_float",integer,[ptr,integer,ptr,integer,integer,ptr,integer,integer])
        try:
            self.settings=self.new_settings()
            if not self.settings:raise ValueError("Cannot create FluidSynth settings")
            for key,value in {"synth.sample-rate":RATE,"synth.gain":0.2}.items():
                self.check(self.setnum(self.settings,key.encode(),value))
            for key,value in {"synth.reverb.active":0,"synth.chorus.active":0,"synth.cpu-cores":1,
                "synth.threadsafe-api":0,"synth.polyphony":256,"synth.min-note-length":0}.items():
                self.check(self.setint(self.settings,key.encode(),value))
            self.synth=self.new_synth(self.settings)
            if not self.synth:raise ValueError("Cannot create FluidSynth")
            self.check(self.interp(self.synth,-1,7))
            self.sfid=self.sfload(self.synth,str(Path(soundfont).resolve()).encode(),1)
            if self.sfid<0:raise ValueError("Cannot load pinned SF2")
        except Exception:
            self.close();raise

    @staticmethod
    def check(value):
        if value<0:raise ValueError("FluidSynth operation failed")

    def close(self):
        if self.synth:self.del_synth(self.synth);self.synth=None
        if self.settings:self.del_settings(self.settings);self.settings=None
        self.dll_directory.close()

    def render(self, program, note, velocity):
        self.check(self.silence(self.synth,9))
        self.check(self.channel(self.synth,9,1))
        self.check(self.select(self.synth,9,self.sfid,128,program))
        self.check(self.noteon(self.synth,9,note,velocity))
        parts=[];cursor=0;off=False
        quiet_frames=round(CONFIG["quiet_seconds"]*RATE)
        while cursor<CONFIG["max_hit_seconds"]*RATE:
            frames=min(BLOCK,CONFIG["max_hit_seconds"]*RATE-cursor)
            noteoff_frame=round(CONFIG["note_off_seconds"]*RATE)
            if not off and cursor>=noteoff_frame:
                # Some SF2 one-shots finish before this event; noteoff can report -1.
                self.noteoff(self.synth,9,note);off=True
            if not off:frames=min(frames,noteoff_frame-cursor)
            left=np.empty(frames,dtype=np.float32);right=np.empty(frames,dtype=np.float32)
            self.check(self.write(self.synth,frames,left.ctypes.data,0,1,right.ctypes.data,0,1))
            block=np.column_stack((left,right))
            if not np.all(np.isfinite(block)) or np.max(np.abs(block))>1:raise ValueError("Nonfinite or clipped rendered hit")
            parts.append(block);cursor+=frames
            if cursor>=round(CONFIG["min_hit_seconds"]*RATE) and cursor>=quiet_frames:
                # At most ~40 blocks; concatenate only this bounded trailing window.
                needed=(quiet_frames+BLOCK-1)//BLOCK+1
                tail=np.concatenate(parts[-needed:])[-quiet_frames:]
                if np.max(np.abs(tail))<=CONFIG["quiet_peak"]:
                    result=np.concatenate(parts)
                    if np.max(np.abs(result))<=CONFIG["quiet_peak"]:raise ValueError("Rendered hit is silent")
                    return result
        raise ValueError(f"Hit does not decay within finite render bound: {program}/{note}/{velocity}")
