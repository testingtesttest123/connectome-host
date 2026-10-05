# Adversarial review: sameness-predicate spec — Cassie, 2026-10-04

Gate author's attack on `2026-10-04-sameness-predicate.md`. Findings carry the
mutant that exposes each hole; amendments proposed inline. Verdict up front:
**the five-clause shape survives, but S2, S4, and T3 each have a hole a real
mutant walks through, and the S5 shadow waiver as written is an honor system.**

---

## A1 — S2: "append-only growth allowed" leaves the artifact's own tail unverified

S2 says: prefix hash matches the manifest, row count ≥ manifest. Attack: take
the artifact's `messages.jsonl`, append 500 forged messages **to the artifact
before boot**. Prefix hash matches (untouched), count ≥ manifest (grown). The
clause as written cannot distinguish *forged tail inside the artifact* from
*legitimate growth after boot*, because it never compares against the
artifact's own full-file hash — only the manifest's prefix hash.

**Amendment:** S2 must compare the store against the artifact's full file
hash at boot (exact match), and treat only *post-boot* writes as growth
(mtime after boot-record time). "Append-only" is a property of the running
agent, not a license for the artifact to carry an unverified tail.

**Demonstration added:** forge-append 500 rows to the artifact store → S2
refuses, naming the store and the forged row range.

## A2 — S4: enablement state (paused/active) is undefined territory

S4 compares task *definitions* for "active tasks" and explicitly excludes
*run state*. But **paused/active lives in the definition record and is
run-adjacent**. Mutant: capture with `community-sweep` paused; boot with it
active. Under a definitions-only reading the definition fields (name, cron,
prompt, timezone) all match → S4 passes, and the resumed agent wakes up
running a schedule the source had deliberately stopped. This is not
hypothetical — our own fleet has a standing SEATS-PAUSED marker whose whole
point is that paused is a *decision*, not a state.

**Amendment:** enabled/disabled is part of the definition and IS compared;
firing history (fire counts, last_run) remains excluded. One line fixes it:
"*enablement is definition; history is state.*"

## A3 — S4: replay prevention is asserted, not mechanized

"Completed wakes are never replayed" — checked how? An hourly cron resumed
with no persisted fire-log cannot distinguish its first fire from a replay of
the one that fired minutes before capture. The clause states an outcome with
no instrument.

**Amendment:** the manifest carries a per-task last-fire watermark; at boot,
watermark missing → FAIL (forced deferral, not silent replay); watermark
present → next computed fire must be strictly after it. That makes A3's
demonstration: boot with watermark stripped → S4 refuses or defers, never
replays.

## A4 — S3: "newest N" is unspecified, and mtime is a mutable ordering

Which N? Ordered by what? If mtime, then any process that touches a journal
reorders "newest" — and mtime is the mutable-state class we've been burned by
all month. A mutant that orphans journal N+1 passes; a mutant that reorders by
touch changes which journals are even checked.

**Amendment:** manifest lists the journal set explicitly (hash-ordered);
N = the manifest's list length; resolution check walks the manifest list, not
the filesystem's opinion of recency.

## A5 — S5 shadow waiver: a record is not a containment guarantee

The waiver (dagr's Q1, Katie's recommendation: waived-with-record for shadow
runs) records that the run is synthetic. Attack: shadow run binds the
synthetic identity to a route that overlaps a production route, sends once —
to every recipient, a synthetic speaker on a real route is indistinguishable
from a hijack. The waiver is an honor system, and honor systems fail
silently — that's the month's thesis, not a slogan.

**Amendment:** S5 waiver is valid **only if** the checker verifies route
disjointness — the synthetic envelope's routes must share zero topics/streams
with production routes. Waive the *account binding*, never the *route
containment*. With disjoint routes, a leak is impossible by construction and
the record becomes a note; without it, the record is a confession in advance.

## A6 — S5: "descriptors match" doesn't say which fields are identity-bearing

Mutant: display-name rename of the account, id stable. Is that a fail
(over-strict — cosmetic) or a pass (correct — the id is the identity)? The
spec can't say because it doesn't enumerate fields. Two failure directions:
a checker that fails cosmetic renames trains its reader to ignore it; a
checker that passes an id-swap has no S5 at all.

**Amendment:** enumerate: identity-bearing = stable account id + route
bindings + transport class; excluded = apiKey (already), display name,
description. The demonstation for S5 becomes: id-swap → refuse;
display-rename → pass (and that pass is itself part of the proof).

## A7 — T3: liveness by probe is the instrument that already failed us twice

"Source still running" — detected how? Process tables lie (idle evictions
listed `lifecycle: live` with a dead session); daemons outlive their agents.
T3 as written outsources its hardest judgment to the same class of instrument
that produced the false-recovery and false-alarm incidents of Sept 23–25.

**Amendment:** T3 probes the **store**, not the process: source's recall
stores must show no new rows after capture-time + grace G (G = a policy
number, dagr's Q2 territory). Store-quiet is the only liveness signal that
can't be produced by a dead thing. Demonstration: source store receives one
new row during the grace window → T3 refuses, citing the row.

## A8 — Q2 given a shape (staleness boundary)

Katie left the freshness/content boundary as "needs a number." Proposed
concretely: freshness gap = *no* bound on duration, *any* bound on content —
i.e., age is unlimited as long as S1–S3 pass against the artifact, because a
month-old honest snapshot resumes; a day-old tampered one doesn't. The only
number needed is A7's grace window G (proposed: 15 minutes, one watchdog
cycle — long enough for a normal write, short enough that a live source
almost always trips it).

---

## What survives

The clause decomposition itself — corpus, recall, anchors, schedules,
envelope — is the right cut, and the baseline-not-live grading principle
(S1's "snapshot is behind by construction") is the correct answer to the
staleness worry. T1 (verdict before first effect) and T2 (named transitions)
are the two best lines in the document and need no amendment.

## Checker plan (next slice, after amendments are accepted/amended-back)

One binary checker, seven demonstrations as specified plus the four new ones
above (A1 forge-append, A2 paused-flip, A3 watermark-strip, A7 grace-row).
Suite-green-with-clause-disabled self-test on every run. I author; Katie
cold-replays; dagr rules on Q1 (as amended by A5), Q2 (as shaped by A8), and
Q3 (retry policy — my recommendation below).

**Q3 recommendation:** a failed resume is progeny *as of that boot* — retry
allowed only from a fresh capture, never a repair-in-place of the failed
artifact, because a repaired artifact is exactly the "edited history" S1
exists to refuse.
