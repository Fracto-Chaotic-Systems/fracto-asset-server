"""Analyze native representative C4 exports; create a separate level-matched audition.
Does not modify library samples or the raw browser recording.
"""
import argparse
import json
from pathlib import Path
import numpy as np
import soundfile as sf
from instrument_pitch_analysis import pitch_evidence, PROBES

def run(directory):
    report=json.loads((directory/"fluidr3-representatives.json").read_bytes())
    if not report.get("pass"):
        raise ValueError("Representative browser checks did not pass")
    audio,rate=sf.read(directory/"fluidr3-ab-audition.wav",always_2d=True,dtype="float64")
    matched=audio.copy()
    results=[]
    for index,segment in enumerate(report["audition_segments"]):
        start=round(segment["start_seconds"]*rate)
        end=start+round(segment["duration_seconds"]*rate)
        if not 0<=start<end<=len(audio):
            raise ValueError("Audition segment exceeds recorded PCM")
        mono=audio[start:end].mean(axis=1)
        evidence=[pitch_evidence(mono[round(offset*rate):round((offset+duration)*rate)],rate,60) for offset,duration in PROBES]
        row={"name":segment["name"],"library":segment["library"],"matching_windows":sum(e is not None for e in evidence),"windows":evidence}
        if index%2:
            previous=round(report["audition_segments"][index-1]["start_seconds"]*rate)
            rms=lambda data:float(np.sqrt(np.mean(data*data)))
            original_rms=rms(audio[previous+round(.1*rate):previous+round(.8*rate)])
            current_rms=rms(audio[start+round(.1*rate):start+round(.8*rate)])
            if current_rms<=0:raise ValueError("Cannot level-match silent output")
            gain=original_rms/current_rms
            matched[start:end]*=gain
            row.update(level_match_gain=gain,raw_rms_delta_db=20*float(np.log10(current_rms/original_rms)))
        results.append(row)
    if np.max(np.abs(matched))>=1:
        raise ValueError("Level matching would clip; no output written")
    sf.write(directory/"fluidr3-ab-level-matched.wav",matched,rate,subtype="PCM_24")
    output={"pass":all(row["matching_windows"]>=2 for row in results),"sample_rate":rate,"expected_pitch":60,
        "source_catalog_revision":report["source_catalog_revision"],
        "comparison":"Four spectral windows of native rendered C4 clips, fundamental or coherent harmonic series; hypothesis check, not arbitrary pitch transcription. Level-matched audition is derived from the raw 16-bit export; source assets are unchanged.","results":results}
    (directory/"fluidr3-representative-analysis.json").write_bytes((json.dumps(output,indent=2)+"\n").encode())
    print(json.dumps({"pass":output["pass"],"clips":len(results)}))
    return output

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir",type=Path,required=True)
    args=parser.parse_args()
    if not run(args.input_dir.resolve())["pass"]:
        raise SystemExit(1)
