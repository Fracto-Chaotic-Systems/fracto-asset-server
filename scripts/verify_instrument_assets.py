"""Independent output/source comparison, excluding only intentional edge fades."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import wave
import numpy as np
import soundfile as sf


def run(root, output):
    root=root.resolve()
    subprocess.run(['node',str(Path(__file__).resolve().parent/'instruments.js'),
                    'verify','--library-dir',str(root)],check=True)
    catalog_bytes=(root/'catalog.json').read_bytes()
    catalog=json.loads(catalog_bytes)
    count=0
    largest_error=0
    for instrument in catalog['instruments']:
        recordings={r['id']:r for r in instrument['recordings']}
        for asset in instrument['playback_assets']:
            recording=recordings[asset['recording_id']]
            index=json.loads((root/recording['timing']['index_path']).read_text(encoding='utf-8'))
            indexed={note['midi_pitch']:note for note in index['notes']}
            with wave.open(str(root/asset['path']),'rb') as reader:
                rate=reader.getframerate()
                pcm=np.frombuffer(reader.readframes(reader.getnframes()),dtype='<i2')
            with sf.SoundFile(root/recording['path']) as source:
                for note in asset['notes']:
                    original=indexed[note['midi_pitch']]
                    start=round(original['offset_seconds']*source.samplerate)
                    end=round(original['end_seconds']*source.samplerate)
                    source.seek(start)
                    reference=source.read(end-start,dtype='float32',always_2d=True).astype(np.float64).mean(axis=1)
                    actual=pcm[note['offset_frames']:note['offset_frames']+note['frames']].astype(np.float64)/32768
                    left=round(.002*rate)
                    right=len(reference)-round(.02*rate)
                    if len(actual)!=len(reference) or right<=left:
                        raise ValueError('Decoded output/source frame count differs')
                    error=float(np.max(np.abs(reference[left:right]-actual[left:right])))
                    if error>1/32768+1e-7:
                        raise ValueError(f'Output/source alignment or quantization error: {asset["id"]} pitch {note["midi_pitch"]}: {error}')
                    largest_error=max(largest_error,error)
                    count+=1
            print(asset['id'],'source alignment verified',flush=True)
    report={'pass':True,'catalog_sha256':hashlib.sha256(catalog_bytes).hexdigest(),
            'assets':sum(len(i['playback_assets']) for i in catalog['instruments']),
            'notes_compared':count,'max_absolute_pcm_error':largest_error,
            'allowed_absolute_pcm_error':1/32768+1e-7,
            'comparison':'All note interiors against indexed original stereo-average samples; intentional 2ms/20ms edge fades excluded.',
            'browser_verification':'pending'}
    if output:
        output.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--library-dir',type=Path,default=Path(__file__).resolve().parent.parent/'instruments')
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    try:
        run(args.library_dir,args.output)
    except Exception as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
