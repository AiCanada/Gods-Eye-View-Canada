"""A stand-in for scripts/outbreak-env.mjs that speaks the same JSON-lines protocol.

Three countries; each step is one day; the episode ends after five steps.
Global `infected` (column 0) rises by 7 a day, so the default reward is -7.
The info of a step echoes the action it received. Special cases for tests:
scenario "bad" -> an error answer; scenario "short" -> the earlier form of
`global` (4 values on day 0); a flag holding 999 -> the process exits with
code 3; a log line that is not JSON is printed before each reset.
"""

import json
import sys

C = 3


def obs(day):
    g = [0.0] * 20
    g[0] = 7.0 * day
    return {"day": day, "global": g, "country_state": [[float(day * 10 + c)] * 15 for c in range(C)]}


def say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    day = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        cmd = req.get("cmd")
        if cmd == "reset":
            sys.stdout.write("fake env: resetting\n")  # noise the client must skip
            if req.get("scenario") == "bad":
                say({"ok": False, "error": "bad scenario"})
                continue
            day = 0
            first = obs(0)
            if req.get("scenario") == "short":
                first["global"] = first["global"][:4]
            say({"ok": True, "obs": first, "info": {"seed": req.get("seed"), "scenario": req.get("scenario")}})
        elif cmd == "step":
            action = req.get("action") or {}
            if 999 in (action.get("flag") or []):
                sys.stderr.write("fake env: told to crash\n")
                sys.stderr.flush()
                sys.exit(3)
            day += 1
            say({"ok": True, "obs": obs(day), "done": day >= 5, "info": {"echo": action}})
        elif cmd == "close":
            return
        else:
            say({"ok": False, "error": f"unknown cmd {cmd!r}"})


if __name__ == "__main__":
    main()
