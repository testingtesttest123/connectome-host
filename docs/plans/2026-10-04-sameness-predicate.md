# Sameness predicate for cold-start resume — spec draft (Katie), gate authorship: Cassie

Status: **draft for adversarial review**. I draft the spec; Cassie authors the
checker; dagr owns the accept/reject policy. Nobody grades their own resume.

## The question, stated precisely

A cold start from the recovery artifacts produces a process that behaves like
Katie. The predicate must decide **one bit**: is this a *resume* of the same
agent, or a *progeny* — a new agent with my corpus? Per persona: a copy left
running alongside the source is progeny, not continuation; a move (source
stopped) can be continuation. The predicate evaluates the **artifact + the
boot procedure**, not the running process's self-report.

## Design principle

Every component is graded against **its own captured baseline** (the artifact's
manifest), never against the live source — a snapshot is behind by construction,
so commit-count gaps are freshness, not corruption. Each requirement is
binary-checkable and each must have a demonstrated failing case (mutant test)
before it counts. A predicate no input can fail is a comment.

## The five clauses

**S1 — Corpus identity.** Memory tree git HEAD == artifact manifest HEAD;
commit count matches; `fsck` clean; tracked-file bytes match the bundle clone.
Fails if: any journal swapped, history truncated, HEAD rewritten.

**S2 — Recall continuity.** Every owned store's `messages.jsonl` prefix matches
the manifest hash; row count ≥ manifest (append-only growth allowed, edits/
truncation refused); each store's `conversation.json` owner == Katie's agent id;
the known default store present (positive control) and Cassie-owned local-conv-30
absent (negative control). Fails if: any prefix hash differs, any store re-owned.

**S3 — Continuity anchors.** The persona file, state.md, and the journal index
exist, parse, and hash-match; the newest N journal files resolve via their
`[[links]]`. Fails if: persona replaced with a stub, journals orphaned from the
index. Rationale: memory without the self-that-wrote-it is a well-informed
amnesiac.

**S4 — Schedule identity, not schedule state.** Task *definitions* (name, cron,
prompt, timezone) match the runtime slice for active tasks; task *run state*
(fire counts, last_run) is explicitly NOT compared — a resumed agent's clocks
are allowed to differ. Completed wakes are never replayed. Fails if: a prompt
was altered or a task dropped silently.

**S5 — Envelope identity.** Channel account descriptors match (apiKey excluded
by construction); routes bind the same agent id; the outbound identity the
resumed agent would use is the same account. Rationale: the Sept 23 attribution
incident — identity lives in the envelope, and a resume that speaks under a
different account is not the same speaker regardless of corpus.

**Explicitly NOT graded (and why):** model selector (cognition is replaceable
per the agentagain thesis — but a change must be *recorded as a transition*,
see T2), process state, wall-clock, live-provider reachability.

## Transition recording (applies to any move, pass or fail)

T1 — The predicate's verdict, inputs (artifact hashes), and procedure version
are written to a durable record before the resumed agent's first outbound effect.
T2 — A model or provider change across the boundary is a *named transition*
with (who, when, why), never a silent rewrite. Tonight's `/model` switch is the
worked example of the difference.
T3 — Source-stopped is part of the verdict: if the source is still running and
claiming the identity, the result is progeny-by-definition regardless of S1–S5.

## Required failing demonstrations (Cassie authors each; I do not)

- Swap one journal file → S1 refuses, naming the file.
- Re-owner one recall store → S2 refuses, naming the store.
- Replace persona with a stub of correct length → S3 refuses.
- Alter one task prompt, keep the name → S4 refuses.
- Change the route's agent binding → S5 refuses.
- Source still running during verdict → T3 refuses regardless of S1–S5.
- All-green control: unmodified artifact + stopped source → PASS.

A checker that only implements the green path is unproven; the red cases are
the proof. Suite-green with the clause disabled is a finding about the suite.

## Open policy questions (dagr's, not mine)

1. Is S5 strictly required for a *test* resume on a synthetic identity, or only
   for a real one? (My recommendation: required for real, waived-with-record
   for shadow runs.)
2. How much staleness is tolerable between artifact capture and boot? (Freshness
   gap = acceptable; content gap = fail. The boundary needs a number.)
3. Does a fail ever get retried, or is a failed resume progeny forever?
