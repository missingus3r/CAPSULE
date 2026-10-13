#!/usr/bin/env python3
"""A history of what a relay's /v1/realtime said, kept by its operator.

The relay itself keeps two peaks and nothing else: it is built not to hold a
record of who was here. This is the other half, for an operator who wants to
see a trend, and it stays outside the relay on purpose. What it writes is what
anybody can already read from the relay's own page: how many addresses made a
request in the last five minutes, and how many relays it knows. Counts, never
addresses.

    capsule-stats.py sample   append one line to the history
    capsule-stats.py report   one line per day: average and highest

Nothing here needs more than the standard library.
"""

import csv
import json
import os
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

RELAY = os.environ.get("CAPSULE_STATS_RELAY", "http://127.0.0.1:8787")
HISTORY = os.environ.get(
    "CAPSULE_STATS_FILE", "/var/lib/capsule-stats/realtime.csv"
)
FIELDS = ["at", "clients", "relays"]


def sample() -> None:
    with urllib.request.urlopen(f"{RELAY}/v1/realtime", timeout=10) as response:
        now = json.load(response)
    row = {
        "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "clients": int(now["clients"]),
        "relays": int(now["relays"]),
    }
    fresh = not os.path.exists(HISTORY) or os.path.getsize(HISTORY) == 0
    with open(HISTORY, "a", newline="", encoding="utf-8") as history:
        writer = csv.DictWriter(history, fieldnames=FIELDS)
        if fresh:
            writer.writeheader()
        writer.writerow(row)


def report(days: int) -> None:
    by_day = defaultdict(list)
    try:
        with open(HISTORY, newline="", encoding="utf-8") as history:
            for row in csv.DictReader(history):
                by_day[row["at"][:10]].append(
                    (int(row["clients"]), int(row["relays"]))
                )
    except FileNotFoundError:
        sys.exit(f"No history yet at {HISTORY}")

    print(f"{'day (UTC)':<11} {'samples':>7}  {'addresses avg':>13} {'max':>4}  "
          f"{'relays avg':>10} {'max':>4}")
    for day in sorted(by_day)[-days:]:
        rows = by_day[day]
        clients = [c for c, _ in rows]
        relays = [r for _, r in rows]
        print(
            f"{day:<11} {len(rows):>7}  "
            f"{sum(clients) / len(rows):>13.1f} {max(clients):>4}  "
            f"{sum(relays) / len(rows):>10.1f} {max(relays):>4}"
        )


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "sample":
        sample()
    elif command == "report":
        report(int(sys.argv[2]) if len(sys.argv) > 2 else 30)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
