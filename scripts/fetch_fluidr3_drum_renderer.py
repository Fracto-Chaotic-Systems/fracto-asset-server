"""Recover the exact pinned official renderer cache; no runtime dependency."""
import argparse
import io
import json
from pathlib import Path
import urllib.request
import zipfile
from fluidr3_drum_renderer import ARCHIVE_SHA256, digest
from import_fluidr3 import safe_path, retain

ROOT=Path(__file__).resolve().parent.parent/"instruments/fluidr3-percussion"


def run(root=ROOT,offline=False):
    lock=json.loads((root/"renderer-lock.json").read_bytes())
    if lock["archive"]["sha256"]!=ARCHIVE_SHA256:raise ValueError("Unknown renderer archive pin")
    cache=safe_path(root,"source-cache/renderer");archive=cache/"renderer.zip"
    if archive.exists():content=archive.read_bytes()
    else:
        if offline:raise ValueError("Missing pinned renderer archive")
        with urllib.request.urlopen(lock["archive"]["url"],timeout=60) as response:content=response.read(lock["archive"]["bytes"]+1)
    if len(content)!=lock["archive"]["bytes"] or digest(content)!=ARCHIVE_SHA256:raise ValueError("Renderer archive checksum mismatch")
    with zipfile.ZipFile(io.BytesIO(content)) as zipped:
        entries=[member for member in zipped.infolist() if not member.is_dir()]
        if len(entries)!=len(lock["files"]) or {member.filename for member in entries}!={member["path"] for member in lock["files"]}:raise ValueError("Renderer archive inventory differs")
        prepared=[]
        for entry in lock["files"]:
            value=zipped.read(entry["path"])
            if len(value)!=entry["bytes"] or digest(value)!=entry["sha256"]:raise ValueError("Renderer entry checksum mismatch")
            safe_path(cache,entry["path"]);retain(cache,entry["path"],value,False);prepared.append((entry["path"],value))
    retain(cache,"renderer.zip",content,True)
    for relative,value in prepared:retain(cache,relative,value,True)
    print(json.dumps({"renderer":lock["renderer"],"version":lock["version"],"files_verified":len(prepared),"archive_sha256":ARCHIVE_SHA256},indent=2))


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--audit-dir",type=Path,default=ROOT);parser.add_argument("--offline",action="store_true")
    args=parser.parse_args();run(args.audit_dir.resolve(),args.offline)
