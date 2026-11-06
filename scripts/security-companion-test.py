#!/usr/bin/env python3
"""Security regression test for the SmartBlocker companion daemon IPC.

Ports the 2026-11-05 red-team attacks (report findings #2/#3/#5, plus the
post-fix contract checks for #2/#8 — see docs/security/red-team-2026-11-05.md)
into a repeatable gate. Runs against an UNSUPERVISED, SCRATCH daemon (scratch
abstract socket + temp data dir — never touches the real install) and asserts
the P0-3/4 hardening holds. PASS = attack fails / defense holds.

  1. pre-auth state disclosure is redacted (password hash + tombstone)
  2. password-arm/swap/clear from unpaired connections is stripped
  3. schedule wipe via forged future schedulesUpdatedAt is rejected
  4. fake browser hello/heartbeat is rejected (watchdog can't be pacified)
  5. legitimate pairing (TOFU hello) authenticates and sees full state
  6. new pairing is refused while a lock is active (no mid-lock self-pair)
  7. authenticated unlock tombstone propagates and persists (#8 regression)

How to run:

    # build the daemon once (offline-friendly):
    cd companion && cargo build -p smartblocker-daemon && cd ..
    # then run (from the repo root):
    python3 scripts/security-companion-test.py
    # or point at another daemon build:
    python3 scripts/security-companion-test.py /path/to/smartblocker-daemon

Exits 0 when every defense holds, 1 on any FAIL (CI-gateable).

Wire format: 4-byte LE length + JSON (companion framing.rs). Linux abstract
socket via the '\\0' prefix (interprocess GenericNamespaced). Every socket
opened here is short-lived on purpose: the daemon's connection lifecycle
(idle reaping caps how long a conn may linger) must never matter to this
test — connect, exchange, close.
"""
import hashlib
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DAEMON = REPO_ROOT / "companion" / "target" / "debug" / "smartblocker-daemon"

DAEMON = sys.argv[1] if len(sys.argv) > 1 else str(DEFAULT_DAEMON)
if not os.path.isfile(DAEMON):
    sys.exit(
        f"daemon binary not found: {DAEMON}\n"
        "build it first:  cd companion && cargo build -p smartblocker-daemon"
    )

SOCKET = f"smartblocker-security-{os.getpid()}"  # listener advertises as SOCKET
DATA = tempfile.mkdtemp(prefix="sb-security-")
PASS = 0
FAIL = 0

# Matches the dev-keyed extension id used across the companion e2e; any string
# works for a scratch daemon, but staying consistent keeps logs recognizable.
EXTENSION_ID = "dhbhbhhcjkfdkfbloeaeedndfjfadajh"


def check(ok, label, extra=""):
    global PASS, FAIL
    print(f"  {'PASS' if ok else 'FAIL'}  {label}  {extra}")
    if ok:
        PASS += 1
    else:
        FAIL += 1


def conn():
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect("\0" + SOCKET)
    s.settimeout(5)
    return s


def send(s, obj):
    body = json.dumps(obj).encode()
    s.sendall(struct.pack("<I", len(body)) + body)


def recv(s):
    hdr = b""
    while len(hdr) < 4:
        chunk = s.recv(4 - len(hdr))
        if not chunk:
            return None
        hdr += chunk
    (n,) = struct.unpack("<I", hdr)
    body = b""
    while len(body) < n:
        chunk = s.recv(n - len(body))
        if not chunk:
            return None
        body += chunk
    return json.loads(body)


def status_lockstate():
    s = conn()
    frame = recv(s)  # daemon pushes companionStatus on connect, pre-auth
    s.close()
    return frame


def sync(lock_state):
    s = conn()
    recv(s)
    send(s, {"type": "lockStateSync", "v": 2, "lockState": lock_state})
    time.sleep(0.4)  # let the daemon process + persist before we assert
    s.close()


def paired_conn(token):
    """Open a conn and authenticate it with a known pairing token."""
    s = conn()
    recv(s)  # redacted greeting
    send(s, {"type": "hello", "v": 2, "extVersion": "0.6.0", "browser": "chrome",
             "extensionId": EXTENSION_ID, "pairing": token})
    reply = recv(s)
    return s, reply


def h(pw):
    return hashlib.sha256(("smartblocker-lock:" + pw).encode()).hexdigest()


def now_ms():
    return int(time.time() * 1000)


def wait_for_listener(proc, stderr_log, timeout_s=10.0):
    """Poll until the scratch socket answers (or the daemon dies trying)."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            tail = Path(stderr_log).read_text(errors="replace")[-2000:]
            sys.exit(f"daemon exited during startup (code {proc.returncode}):\n{tail}")
        try:
            s = conn()
            s.close()
            return
        except OSError:
            time.sleep(0.1)
    sys.exit(f"daemon never opened its scratch socket within {timeout_s}s")


daemon_log = os.path.join(DATA, "daemon-stderr.log")
with open(daemon_log, "wb") as log_fp:
    daemon = subprocess.Popen(
        [DAEMON, "run", "--socket", SOCKET, "--data-dir", DATA],
        env={**os.environ, "SMARTBLOCKER_NO_WATCHDOG": "1"},
        stdout=log_fp,
        stderr=log_fp,
    )
try:
    wait_for_listener(daemon, daemon_log)

    print("=== setup: victim browser pairs + arms a password lock (hash of 'correct horse') ===")
    victim_hash = h("correct horse")
    s, reply = paired_conn("victim-token")
    s.close()
    check(reply and reply.get("type") == "companionStatus",
          "legitimate pairing token authenticates (TOFU hello)", )
    # Arm the password via the PAIRED connection: password writes from
    # unpaired connections are stripped by the daemon (that's check 2, and it
    # must not accidentally do the arming for us).
    s, _ = paired_conn("victim-token")
    send(s, {"type": "lockStateSync", "v": 2, "lockState":
             {"timerUntil": None, "passwordHash": victim_hash, "passwordTs": now_ms(),
              "frozenUntil": None, "schedules": [], "schedulesUpdatedAt": now_ms()}})
    time.sleep(0.4)
    s.close()
    armed = json.load(open(os.path.join(DATA, "lock-state.json")))
    check(armed.get("passwordHash") == victim_hash,
          "setup: password armed daemon-side via the paired connection")

    print("=== 1. pre-auth disclosure (finding #2a) ===")
    ls = (status_lockstate() or {}).get("status", {}).get("lockState", {})
    check(ls.get("passwordHash") is None and ls.get("passwordTs", 1) == 0,
          "pre-auth status redacts the password fields (hash + tombstone)",
          f"got hash={str(ls.get('passwordHash'))[:16]} ts={ls.get('passwordTs')}")

    print("=== 2. password swap via unauthenticated IPC (finding #2b) ===")
    attacker = None
    for i in range(1, 100):
        cand = h(f"letmein{i}")
        if cand < victim_hash:
            attacker, chosen = cand, f"letmein{i}"
            break
    # lexicographic-smaller attack AND a fresh-tombstone attack — both must fail
    sync({"timerUntil": None, "passwordHash": attacker, "passwordTs": now_ms(),
          "frozenUntil": None, "schedules": [], "schedulesUpdatedAt": now_ms()})
    sync({"timerUntil": None, "passwordHash": None, "passwordTs": now_ms() + 1,
          "frozenUntil": None, "schedules": [], "schedulesUpdatedAt": now_ms()})
    disk = json.load(open(os.path.join(DATA, "lock-state.json")))
    check(disk.get("passwordHash") == victim_hash,
          "password arm/swap/clear from unpaired conns is stripped (merge keeps daemon's)",
          f"disk hash still victim's after lex-min + tombstone attempts")

    print("=== 3. schedule wipe + forged future schedulesUpdatedAt (finding #3) ===")
    rule = {"id": "work", "days": [1, 2, 3, 4, 5], "startMinutes": 9 * 60, "endMinutes": 17 * 60}
    s, _ = paired_conn("victim-token")
    send(s, {"type": "lockStateSync", "v": 2, "lockState":
             {"timerUntil": None, "passwordHash": victim_hash, "passwordTs": 1000,
              "frozenUntil": None, "schedules": [rule], "schedulesUpdatedAt": now_ms()}})
    time.sleep(0.4)
    s.close()
    disk = json.load(open(os.path.join(DATA, "lock-state.json")))
    check(len(disk.get("schedules", [])) == 1, "setup: schedule armed via paired conn")
    future = now_ms() + 30 * 24 * 3600 * 1000 - 3_600_000  # way past 'now'
    sync({"timerUntil": None, "passwordHash": None, "frozenUntil": None,
          "schedules": [], "schedulesUpdatedAt": future})
    disk = json.load(open(os.path.join(DATA, "lock-state.json")))
    check(len(disk.get("schedules", [])) == 1 and disk.get("schedulesUpdatedAt", 0) < future,
          "unpaired forged-future-ts wipe rejected (schedules pinned + clamped)",
          f"ts={disk.get('schedulesUpdatedAt')} rules={len(disk.get('schedules', []))}")

    print("=== 4. fake browser hello/heartbeat (finding #5) ===")
    s = conn()
    recv(s)
    send(s, {"type": "hello", "v": 2, "extVersion": "0.5.0", "browser": "chrome",
             "extensionId": EXTENSION_ID})  # no pairing
    reply2 = recv(s)
    send(s, {"type": "heartbeat", "v": 2, "now": now_ms()})
    time.sleep(0.5)
    s.close()
    events = open(os.path.join(DATA, "events.log")).read()
    rejected = "hello-rejected" in events
    # Setup legitimately logs "hello Chrome ext 0.6.0" for the PAIRED conn;
    # the forged one here claims extVersion 0.5.0 — it must NOT be accepted.
    accepted = any("hello Chrome ext 0.5.0" in l for l in events.splitlines())
    check(rejected and not accepted and reply2 and reply2.get("type") == "error",
          "unpaired hello rejected, heartbeats never register a browser",
          f"reply={reply2 and reply2.get('message')}")

    print("=== 5. pair-while-locked refusal (finding #2 hardening) ===")
    s = conn()
    recv(s)
    send(s, {"type": "hello", "v": 2, "extVersion": "0.6.0", "browser": "edge",
             "extensionId": "attacker", "pairing": "attacker-token"})
    reply3 = recv(s)
    s.close()
    cfg = json.load(open(os.path.join(DATA, "config.json")))
    tokens = cfg.get("pairingTokens", [])
    check(reply3 and reply3.get("type") == "error" and "attacker-token" not in tokens,
          "new pairing refused while locked (no mid-lock self-pair)",
          f"tokens={len(tokens)}")

    print("=== 6. authenticated unlock propagates (finding #8 regression) ===")
    s, _ = paired_conn("victim-token")
    send(s, {"type": "lockStateSync", "v": 2, "lockState":
             {"timerUntil": None, "passwordHash": None, "passwordTs": now_ms(),
              "frozenUntil": None, "schedules": [rule], "schedulesUpdatedAt": now_ms()}})
    time.sleep(0.4)
    s.close()
    disk = json.load(open(os.path.join(DATA, "lock-state.json")))
    check(disk.get("passwordHash") is None and disk.get("passwordTs", 0) > 0,
          "paired unlock tombstone accepted + persisted (no re-arm loop)",
          f"ts={disk.get('passwordTs')}")
finally:
    daemon.terminate()
    try:
        daemon.wait(timeout=5)
    except subprocess.TimeoutExpired:
        daemon.kill()

print()
print(f"security regression: {PASS} passed, {FAIL} failed")
if FAIL:
    log_tail = Path(daemon_log).read_text(errors="replace")[-2000:]
    print(f"--- daemon log tail ({daemon_log}) ---\n{log_tail}")
shutil.rmtree(DATA, ignore_errors=True)
sys.exit(1 if FAIL else 0)
