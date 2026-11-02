"""Deterministic bounded mono PCM16 sprites built from verified source windows."""
import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import wave
import numpy as np
import soundfile as sf

METHOD_VERSION = 'mono-octave-pcm16-v1'
REFERENCE_RATE = 48000
MAX_DECODED_BYTES = 48 * 1024 * 1024
SILENCE_SECONDS = .05
FADE_IN_SECONDS = .002
FADE_OUT_SECONDS = .02


def sha256(content):
    return hashlib.sha256(content).hexdigest()


def serialize(value):
    return (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + '\n').encode('utf-8')


def estimated_bytes(frames, sample_rate):
    return math.ceil(frames * REFERENCE_RATE / sample_rate) * 4


def plan_chunks(notes, sample_rate, max_bytes=MAX_DECODED_BYTES):
    chunks, current = [], []
    frames = 0
    gap = round(SILENCE_SECONDS * sample_rate)
    for note in notes:
        start = round(note['offset_seconds'] * sample_rate)
        end = round(note['end_seconds'] * sample_rate)
        count = end - start
        if count <= 0 or estimated_bytes(count, sample_rate) > max_bytes:
            raise ValueError('A single verified note exceeds the decoded asset budget')
        octave = note['midi_pitch'] // 12 - 1
        if current and (octave != current[-1]['midi_pitch'] // 12 - 1 or
                        estimated_bytes(frames + gap + count, sample_rate) > max_bytes):
            chunks.append(current)
            current, frames = [], 0
        if current:
            frames += gap
        current.append(note)
        frames += count
    if current:
        chunks.append(current)
    return chunks


def mono_pcm(samples, sample_rate):
    # Preserve source amplitude and stereo balance; no per-note normalization.
    mono = samples.astype(np.float64).mean(axis=1)
    if not len(mono) or not np.all(np.isfinite(mono)):
        raise ValueError('Empty or non-finite source window')
    peak = float(np.max(np.abs(mono)))
    if peak > 1:
        raise ValueError(f'Mono downmix would clip PCM16: peak {peak}')
    fade_in = min(len(mono), round(FADE_IN_SECONDS * sample_rate))
    fade_out = min(len(mono), round(FADE_OUT_SECONDS * sample_rate))
    if fade_in:
        mono[:fade_in] *= np.linspace(0, 1, fade_in)
    if fade_out:
        mono[-fade_out:] *= np.linspace(1, 0, fade_out)
    # Saturate only the asymmetric +1.0 endpoint; larger overshoots fail above.
    integers = np.rint(mono * 32768).clip(-32768, 32767).astype('<i2')
    return integers, peak


def render_chunk(audio, notes):
    rate = audio.samplerate
    gap = round(SILENCE_SECONDS * rate)
    parts, mappings = [], []
    cursor, peak = 0, 0
    for note in notes:
        start = round(note['offset_seconds'] * rate)
        end = round(note['end_seconds'] * rate)
        if not (0 <= start < end <= len(audio)):
            raise ValueError('Source bounds exceed recording')
        if parts:
            parts.append(np.zeros(gap, dtype='<i2'))
            cursor += gap
        audio.seek(start)
        samples = audio.read(end - start, dtype='float32', always_2d=True)
        if len(samples) != end - start:
            raise ValueError('Incomplete source decode')
        pcm, source_peak = mono_pcm(samples, rate)
        onset = round(note['onset_seconds'] * rate) - start
        mappings.append({
            'midi_pitch': note['midi_pitch'],
            'source_start_frame': start, 'source_end_frame': end,
            'offset_frames': cursor, 'frames': len(pcm),
            'onset_frame': cursor + onset,
            'offset_seconds': round(cursor / rate, 9),
            'duration_seconds': round(len(pcm) / rate, 9),
            'tail_guarded': note['tail_guarded'],
        })
        parts.append(pcm)
        cursor += len(pcm)
        peak = max(peak, source_peak)
    combined = np.concatenate(parts)
    if estimated_bytes(len(combined), rate) > MAX_DECODED_BYTES:
        raise ValueError('Generated chunk exceeds decoded budget')
    output = io.BytesIO()
    with wave.open(output, 'wb') as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(combined.tobytes())
    return output.getvalue(), mappings, peak


def validate_pcm(content, notes, rate):
    # Independent WAV container readback and PCM checks before publishing.
    with wave.open(io.BytesIO(content), 'rb') as reader:
        if (reader.getnchannels(), reader.getsampwidth(), reader.getframerate()) != (1, 2, rate):
            raise ValueError('Unexpected playback encoding')
        pcm = np.frombuffer(reader.readframes(reader.getnframes()), dtype='<i2')
    previous_end = 0
    for note in notes:
        start, end = note['offset_frames'], note['offset_frames'] + note['frames']
        if start < previous_end or end > len(pcm) or not np.any(pcm[start:end]):
            raise ValueError('Invalid or silent playback note')
        if pcm[start] != 0 or pcm[end - 1] != 0 or np.any(pcm[previous_end:start]):
            raise ValueError('Missing fade/silence at note boundary')
        previous_end = end


def run(root, apply):
    root = root.resolve()
    verify_script = Path(__file__).resolve().parent / 'instruments.js'
    subprocess.run(['node', str(verify_script), 'verify', '--sources-only', '--library-dir', str(root)], check=True)
    catalog_path = root / 'catalog.json'
    original_catalog = catalog_path.read_bytes()
    catalog = json.loads(original_catalog)
    if any(item.get("library_id", "legacy") != "legacy" for item in catalog["instruments"]):
        raise ValueError("This legacy grid tool cannot rewrite a mixed-library catalog; use the library-specific importer.")
    reports, generated, reused = [], 0, 0
    for instrument in catalog['instruments']:
        assets = []
        for recording in instrument['recordings']:
            index_path = root / recording['timing']['index_path']
            index_content = index_path.read_bytes()
            if sha256(index_content) != recording['timing']['index_sha256']:
                raise ValueError('Index checksum changed')
            index = json.loads(index_content)
            with sf.SoundFile(root / recording['path']) as audio:
                if (audio.samplerate, audio.channels, len(audio)) != (index['sample_rate'], index['channels'], index['frames']):
                    raise ValueError('Source decoder alignment changed')
                chunks = plan_chunks(index['notes'], audio.samplerate)
                for number, notes in enumerate(chunks):
                    content, mappings, peak = render_chunk(audio, notes)
                    validate_pcm(content, mappings, audio.samplerate)
                    digest = sha256(content)
                    relative = f"playback/{recording['id']}/{digest}.wav"
                    asset = {
                        'id': f"{recording['id']}-chunk-{number}",
                        'recording_id': recording['id'], 'velocity_layer': recording['velocity_layer'],
                        'method_version': METHOD_VERSION,
                        'source_sha256': recording['sha256'],
                        'index_sha256': recording['timing']['index_sha256'],
                        'path': relative, 'sha256': digest, 'bytes': len(content),
                        'mime_type': 'audio/wav', 'encoding': 'pcm_s16le',
                        'sample_rate': audio.samplerate, 'channels': 1,
                        'frames': mappings[-1]['offset_frames'] + mappings[-1]['frames'],
                        'source_peak': round(peak, 9), 'notes': mappings,
                    }
                    asset['duration_seconds'] = round(asset['frames'] / audio.samplerate, 9)
                    asset['decoded_bytes_at_48000'] = estimated_bytes(asset['frames'], audio.samplerate)
                    target = root / relative
                    if (root / 'playback').is_symlink() or target.parent.is_symlink():
                        raise ValueError('Playback directories must not be symbolic links')
                    if target.exists():
                        if target.is_symlink() or sha256(target.read_bytes()) != digest:
                            raise ValueError(f'Conflicting playback asset: {relative}')
                        reused += 1
                    elif apply:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        if target.parent.is_symlink() or (root / 'playback').is_symlink():
                            raise ValueError('Playback directories must not be symbolic links')
                        with target.open('xb') as output:
                            output.write(content)
                        generated += 1
                    assets.append(asset)
            print(json.dumps({'recording': recording['id'], 'chunks': len(chunks),
                              'notes': len(index['notes'])}), flush=True)
        instrument['playback_assets'] = assets
        instrument['verification_status'] = 'assets_prepared'
        reports.extend(assets)
    catalog['library_version'] = 3
    catalog['playback_preparation'] = {
        'method_version': METHOD_VERSION, 'format': 'mono-pcm16-wav',
        'reference_sample_rate': REFERENCE_RATE, 'max_decoded_bytes': MAX_DECODED_BYTES,
        'silence_seconds': SILENCE_SECONDS, 'fade_in_seconds': FADE_IN_SECONDS,
        'fade_out_seconds': FADE_OUT_SECONDS, 'normalization': 'none',
        'numpy_version': np.__version__, 'soundfile_version': sf.__version__,
        'libsndfile_version': sf.__libsndfile_version__,
        'asset_count': len(reports), 'note_count': sum(len(asset['notes']) for asset in reports),
        'encoded_bytes': sum(asset['bytes'] for asset in reports),
        'largest_decoded_bytes_at_48000': max(asset['decoded_bytes_at_48000'] for asset in reports),
        'browser_verification': 'pending',
    }
    if apply:
        if catalog_path.read_bytes() != original_catalog:
            raise ValueError('Catalog changed during preparation; not publishing results')
        temporary = root / 'catalog.json.next'
        with temporary.open('xb') as output:
            output.write(serialize(catalog))
        os.replace(temporary, catalog_path)
    print(json.dumps({'applied': apply, 'generated': generated, 'reused': reused,
                      **catalog['playback_preparation']}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--library-dir', type=Path, default=Path(__file__).resolve().parent.parent / 'instruments')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        run(args.library_dir, args.apply)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
