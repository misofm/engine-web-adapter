#!/usr/bin/env python3
"""Stage the frozen issue #77 inputs using curl and a caller-owned gateway URL."""

import argparse
import json
from pathlib import Path
import subprocess

import run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--url-template", required=True)
    args = parser.parse_args()
    args.output = args.output.resolve()
    run.require(not args.output.is_relative_to(run.HERE.parent.parent), "Stage audio outside the repository")
    run.require("{blob_id}" in args.url_template, "URL template must contain {blob_id}")
    args.output.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((run.HERE / "sources.json").read_text())
    inputs = {}
    for row in catalog["stems"]:
        identity = row["identity"].split(":")[1]
        inputs[identity] = {}
        for kind, key, size, digest in [
            ("original", "originalBlobId", "originalTransportBytes", "originalFlacSha256"),
            ("published", "blobId", "bytes", "sha256"),
        ]:
            target = args.output / f"{identity}.{kind}"
            if not target.exists():
                partial = target.with_suffix(target.suffix + ".partial")
                subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error",
                                "--max-time", "300", "--output", str(partial), "--",
                                args.url_template.format(blob_id=row[key])], check=True)
                run.check_file(partial, row[size], row[digest])
                partial.replace(target)
            run.check_file(target, row[size], row[digest])
            inputs[identity][kind] = str(target)
        print(f"{row['recordingRef']}/{row['sourceIDs'][0]}: both original and published blobs verified", flush=True)
    run.write_json(args.output / "local-inputs.json", inputs)


if __name__ == "__main__":
    main()
