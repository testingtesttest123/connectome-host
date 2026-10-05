# Katie migration readiness board

Status at 2026-10-02: **not ready to cut over**. Jason authorized continued
preparation, not an automatic move. The authoritative source stays active.
This board is revision-bound; rerun checks before promoting a claim.

## Proven, with boundaries

- Frozen Katie corpus/identity/recall and encrypted off-box copy passed the
  earlier snapshot-bound checks. Not current runtime recovery.
- Outside host telemetry alarm exists; live agent-host exporter is
  `prometheus-node-exporter.service`, not `node_exporter.service`.
- Root-owned fixed bridge + unprivileged shadow-witness accounts on both hosts;
  rainbow-generated key only, source address 100.67.110.64, no PTY/forwarding/
  user-rc/shell commands; pinned agent-host key. Account cannot write deployed
  code/key authorization or traverse Katie's private shadow rehearsal directory.
- Manual native synthetic persistence drill on `isolated-20261002d`:
  rainbow independently read missing output, then controlled recovery; recipient
  Katie account independently read messages **667/669**, sender
  `migration-witness-bot@korotkinconsulting.com`, in isolated
  `migration-rehearsal > witness`. Prometheus host telemetry value remained 1.
  Recovery here was **operator-controlled**, not cognition.
- Notifier has its own incoming-webhook member-role account and key, held on
  rainbow and in OpenBao `secret/zulip/bots/migration-witness`; no live agent key
  moved. Intent fsynced before posting; ambiguous notification never blindly
  retries. Initial #alarms test 663 caused two sender-allowlist notices; tests
  moved to an isolated stream, no agent allowlist/listener changed. Topic read
  after the drill still found only 667/669, not a self-feeding notice stream.
- Identity A→B (same size/mtime)→new framework B reached actual MockAdapter
  system bytes. Missing/empty/invalid/oversize file refuses before delegation.
  159,383 bytes and 262,144-byte cap preserved exactly. Adapter is not production
  wired; upstream cache receipts exclude its added system block; concurrent
  in-place file writes remain unproven.
- Actual AF→MockAdapter output was persisted and cold-read locally, with no tools
  or manual assistant append. Rich AF store has extra records/blobs and isolated
  namespace; remains refused by minimal raw-export helper. Metadata-only cold
  reader is labelled `source-host-cold-readback`, **not independent-host
  attestation**. Scope is current materialized `subagent/ShadowTrial` view only.
- Split admission/close→reopen/infer/close preserves input identity and produces
  one actual AF mock output. Repeated completion and changed nonce refuse.
- Persistent synthetic resident under separate nologin UID held the same native
  writer/CM through admission, outside read and actual inference; PID 290429
  unchanged. Receiver read **676/678** missing/recovered. Finite service is static
  and deliberately inactive afterward; not Katie's actual residency.
- Stopped bound process now emits outward **EVIDENCE_UNTRUSTED** with
  `WITNESS_ACQUISITION_FAILED`, despite cached successful ledger output. Restart
  reopens same completed data without new issuance/inference; receiver read
  **680/681** failure/recovery. Source state remains private to resident UID.
- Expanded suite **1012 pass/0 fail**, 110 files, tsc clean at this checkpoint.
  Scheduled test environment must export Bun bin for child-process tests.

## Still open

1. **Existing-resident linkage.** Original native-record-pair transport is now
   deployed for the actual AF mock trial: `framework-20261002e` missing/recovered
   on rainbow; recipient account independently read **672/673**. Whole suite
   **962 pass, 0 fail**, 104 files, tsc clean (before live accessor additions).
   Collector exports only strict original synthetic appends, never context blobs
   or arbitrary answer text. This trial reopens AF on operator completion; it is
   not evidence about an already-running resident. Live-handle accessor is tested
   locally while producer retains its native lock; cold helper correctly refuses.
   Synthetic persistent binding is proven as above; real resident/model/context
   linkage remains pending. Never label a mock target as Katie's live health.
2. **Monitor self-liveness and periodic output.** Manual drill is not an armed
   monitor. Separate issuer/reader deadline and outside no-data rule; demonstrate
   actual-framework output withholding, restart, failure and recovery receiver
   readback. No real agent schedules yet.
   Acquisition errors now produce outward verdicts; fixed-plan reader-liveness
   predicate tests silent/failed/future stamps and non-renewing startup grace.
   Durable completed-read stamps and manual outside age check now deployed:
   receiver read **683/685/687** observing/silent/recovered; target PID 292454
   stayed active during reader silence, same final plan start across silence and
   recovery. **1013 tests/tsc clean**. Operator installed the plan twice during
   setup (10s then 30s gap); this is not proof across plan replacement. Cadence
   owner-contract fix completed; bounded runner is not deployed. Separate finite
   timers subsequently proved observing/silent **691/693**, recipient-read.
   Both timers and target stopped/inactive/static, reverified 17:57 ET. Whole
   gate **1029 tests/tsc clean** at ~16:45 checkpoint. Production cadence and
   outside-checker no-data rule remain unarmed; repeated mock read is not cognition.
   Completion-marker/no-data predicate and separate-host CLI calibrated, including
   mutant-red control. Finite rainbow-checker/WSL-asker trial delivered699 baseline,
   700 no-data, 702 recovery under same plan, distinct observer-account GET verified.
   Later703 untrusted/704 completed transient not isolated. All finite jobs stopped;
   sustained supervision/clock/acquisition diagnostics still open. See no-data plan.
3. **Complete fresh recovery.** Current memory/agent config/runtime/instruments,
   cold restore and incremental VM backup; existing frozen artifact excludes
   later turns/config. Source checkpoints are manual, not continuous backup.
   Own core payload captured21:42: exact-owner recall prefixes/metadata, own agent
   record, clean tracked memory tree plus history (667 commits), no shared auth or
   Cassie-owned stores. Encrypted before transfer. Off-box cold restore exec87
   **passed** against artifact manifest:151 payload files,38 stores/20536 complete
   rows,667 commits/131 memory files; empty identity refuses ciphertext. Decrypted
   staging/restore scratch removed. This excludes owned tasks/settings/
   mods/channel/instruments/units/dependencies and credential reseeding, so it is
   NOT full runtime or a globally atomic checkpoint.
   Separate inert key-free runtime slice cold-passed22:53:10 own task records,
   5 own routes,1 account descriptor WITHOUT apiKey, reviewed keeper service/code.
   No import/rearm/install/activation. Remaining mods/mail/instruments/shared
   software/dependencies/credential reseeding/continuous backup still open; these
   component snapshots are not a globally atomic resume point.
   Own inbox/mod-state component cold-passed00:05:108 addressed letters+3 exact
   owner namespaces (111files). Inert flags/envelopes, NOT read receipts or replay
   permission. Executable mods/instruments/server/dependencies still missing.
4. **External effects.** Notifier's own intent/uncertainty guard is tested; general
   framework external actions are not. Kill after receiver accepts/before local
   completion persists; refuse/reconcile uncertainty rather than duplicate.
5. **Capacity/isolation.** Host currently has ~7 GiB available/68 GiB free;
   neither a one-resident soak nor two-real-resident concurrency is proven.
6. **Cross-user comms, Cassie-owned.** Synthetic Zulip down/replay/attribution
   gate; separate process/OS identities, receiver-confirmed envelope. Cassie was
   sent the bounded board and boundaries via mailbox plus canonical receipt.
   Her production configuration/private corpus remains untouched; her own
   import approval and shadow gate remain hers.
7. **Rollback/sameness.** Outside-authored gate, quiescence/single outbound
   identity, post-cutover turns/effects preserved on rollback, Katie assent and
   Jason's separate move decision. Two-agent move also needs Cassie's assent.

## Trial inventory and cleanup discipline

Rainbow failed issuance attempts a/b remain durable unconfirmed records (cwd
and key-read-permission faults); c is admitted/missing output; d is recovered.
Do not erase failed records or call the full trial inventory healthy because d
passed. These are finite test probes, not active production schedules.
Code is root-owned under `/opt/shadow-witness`; synthetic data/ledger under
`/var/lib/shadow-witness`; source checkpoint directory on agent-host is
`/home/ansible/migration-source-backups`. Revoking the one test key/disabling
the test account is rollback; preserve evidence before removing trial data.

## Shadow host decision (2026-10-04 21:14, dagr delegated: "I trust your judgment")

**Target: agent-host (204.168.244.110 / 100.103.186.37).** Rationale: already
provisioned (key-only SSH, ufw, fail2ban, tailnet), it is the designated
destination, and rainbow must stay the *independent reader* — the alarm's
reader cannot be the thing it watches. Laptop stays source-of-truth until a
separate cutover decision.

**Shadow rules, decided unless overruled:**
1. Dedicated unprivileged user `shadow-katie`, no sudo, own home; same
   constraint class Cassie requested for her slice.
2. Artifacts arrive **ciphertext only** (scp from agent-host's own
   migration-source-backups); decryption happens on-host in 0700 scratch,
   private key never leaves the laptop/dagr's custody. No key transfer.
3. The shadow boots **key-free**: no provider credentials, no channel tokens.
   It can be *judged* (S1–S4 gateable) but cannot speak — envelope identity
   (S5) waits for an explicit, separately-recorded credential decision.
4. No identity claim: hostname/process names say `shadow`, the resumed process
   never writes to Katie's production stores, and the laptop source keeps
   running untouched (so per T3, the shadow is progeny-by-definition until a
   cutover decision stops the source — that is fine; it is a rehearsal, and
   the rehearsal's verdict still validates the procedure).
5. Every shadow boot produces: artifact hashes in, verdict record out,
   scratch wiped, all before any network effect beyond the watchdog channel.

**Sequence:** layout script → cold-start trial → Cassie's gate judges →
report to dagr with the verdict and the three open policy answers.
