#!/usr/bin/env python3
"""Report on one member work folder. Prints a single JSON object on stdout.

Run standalone as a smoke test:
    python3 workflows/inspect-members/inspect.py --root workdir/BOILERPLATE-DOER --files
"""
import argparse
import json
import os
import sys

# Claude Code truncates tool output at 25,000 tokens by default, so an
# unbounded listing of a large work folder would silently lose its tail.
MAX_ENTRIES = 50


def build_report(root, include_files):
    report = {"root": root, "exists": os.path.isdir(root)}
    if not report["exists"]:
        return report

    file_count = 0
    total_bytes = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            file_count += 1
            try:
                total_bytes += os.path.getsize(os.path.join(dirpath, name))
            except OSError:
                pass
    report["fileCount"] = file_count
    report["totalBytes"] = total_bytes

    if include_files:
        names = sorted(os.listdir(root))
        report["entries"] = names[:MAX_ENTRIES]
        report["entriesOmitted"] = max(0, len(names) - MAX_ENTRIES)

    return report


def main():
    parser = argparse.ArgumentParser(description="Inspect a member work folder.")
    parser.add_argument("--root", required=True, help="Path to the member work folder")
    parser.add_argument(
        "--files", action="store_true", help="Include a capped listing of top-level entries"
    )
    args = parser.parse_args()
    print(json.dumps(build_report(args.root, args.files)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
