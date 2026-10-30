#!/usr/bin/env bun
/**
 * Warmup a conhost session: drive its AutobiographicalStrategy to convergence
 * before the session is opened for real continuation.
 *
 * Bulk-imported sessions (from claude.ai exports, etc.) land in Chronicle with
 * thousands of raw messages and no L1/L2/L3 summaries. At runtime, autobio's
 * uncompressed-fallback would emit everything raw at first compile, blowing
 * the context window. This script pre-computes all summaries so the session
 * is openable.
 *
 * Compression is driven by the same model used at conversation time
 * (Sonnet 4.5 by default) — autobio's prompts are explicitly first-person
 * ("describe it as you would to yourself"), so the summarizer is literally
 * writing the friend's-Claude's own diary. Haiku here would be a different
 * voice wearing the same name.
 *
 * Resumable: autobio persists its compression and merge queues to Chronicle.
 * If interrupted, re-running this script picks up where it left off.
 *
 * Run:
 *   bun scripts/warmup-session.ts <session-name-or-id>
 *
 * Options:
 *   --data-dir <dir>   Conhost data dir (default: ./data)
 *   --model <id>       Compression model (default: claude-sonnet-4-5-20250929)
 *   --agent <name>     Participant name for assistant turns. If omitted,
 *                      read from the import-source sidecar written by
 *                      `import-claudeai-export.ts`; falls back to "Claude"
 *                      if neither is available. MUST match the value the
 *                      session was imported with — Membrane formats the
 *                      assistant role by string-comparing message
 *                      participants against this name.
 *   --max-spend <usd>  Soft cap; halt gracefully if cost exceeds this
 *   --l1-budget <n>    L1 budget tokens (passed to autobio)
 *   --l2-budget <n>    Likewise L2
 *   --l3-budget <n>    Likewise L3
 *   --merge-threshold <n>  L1→L2 / L2→L3 merge threshold (default: 6)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import { AutobiographicalStrategy } from '@animalabs/agent-framework';
import { Membrane, AnthropicAdapter, BedrockAdapter, OpenAICompatibleAdapter, type NormalizedResponse } from '@animalabs/membrane';
import { SessionManager } from '../src/session-manager.js';
import { resolveAgentName } from '../src/agent-name.js';

// ---------------------------------------------------------------------------
// Pricing (approximate, USD per 1M tokens). Used for the --max-spend gate
// and the on-screen running cost.
// Keep in sync with any canonical billing source if/when one is consolidated
// (per memory: project_billing_tracker.md). Stale entries here only affect
// the cost displayed during warmup; the actual spend is whatever Anthropic
// charges.
// ---------------------------------------------------------------------------

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
  'claude-opus-4-7': { input: 15.0, output: 75.0 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
  // DeepSeek v4.1 flash via a reseller gateway (commandcode). These are the
  // underlying API rates the gateway pass-throughs, not a marked-up price.
  'deepseek/deepseek-v4.1-flash': { input: 0.28, output: 0.42 },
};

function priceOf(model: string): { input: number; output: number } {
  return PRICING[model] ?? { input: 3.0, output: 15.0 };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Opts {
  sessionRef: string;
  dataDir: string;
  model: string;
  /**
   * Explicit `--agent <name>` from the CLI. When absent (undefined), the
   * runner falls back to the session's import-source sidecar, then to
   * "Claude". Distinguishing "not given" from "given as 'agent'" lets the
   * sidecar (the durable record of what the importer wrote) override a
   * stale default without overriding a deliberate operator choice.
   */
  agentName?: string;
  maxSpend: number | null;
  /** 'anthropic' (default), 'bedrock', or 'openai-compatible'. Inferred from
   *  the model id when omitted, so existing invocations are unchanged. */
  provider: 'anthropic' | 'bedrock' | 'openai-compatible';
  /** Base URL for the openai-compatible provider (required for that mode). */
  baseUrl: string | null;
  /** Chunk size for autobiographical compression. Costs scale with the number
   *  of chunks, not their size: each compression call re-reads the carried
   *  summary archive, so ~4k chunks cost ~4x what ~16k chunks do. Set at the
   *  first strategy open — chunk boundaries are computed then, not at import. */
  targetChunkTokens: number | null;
  l1Budget?: number;
  l2Budget?: number;
  l3Budget?: number;
  mergeThreshold?: number;
}

function parseArgs(argv: string[]): Opts {
  const args = argv.slice(2);
  if (args.length === 0 || args[0]?.startsWith('-')) {
    console.error(
      'Usage: bun scripts/warmup-session.ts <session-name-or-id> [--data-dir <dir>] [--model <id>] [--agent <name>] [--max-spend <usd>] [--l1-budget <n>] [--l2-budget <n>] [--l3-budget <n>] [--merge-threshold <n>]',
    );
    process.exit(1);
  }
  const opts: Opts = {
    sessionRef: args[0]!,
    dataDir: resolve(process.cwd(), 'data'),
    model: 'claude-sonnet-4-5-20250929',
    maxSpend: null,
    provider: 'anthropic',
    baseUrl: null,
    targetChunkTokens: null,
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--data-dir') opts.dataDir = resolve(args[++i]!);
    else if (a === '--model') opts.model = args[++i]!;
    else if (a === '--agent') opts.agentName = args[++i]!;
    else if (a === '--max-spend') opts.maxSpend = parseFloat(args[++i]!);
    else if (a === '--provider') opts.provider = args[++i] as Opts['provider'];
    else if (a === '--base-url') opts.baseUrl = args[++i]!;
    else if (a === '--target-chunk-tokens') opts.targetChunkTokens = parseInt(args[++i]!, 10);
    else if (a === '--l1-budget') opts.l1Budget = parseInt(args[++i]!);
    else if (a === '--l2-budget') opts.l2Budget = parseInt(args[++i]!);
    else if (a === '--l3-budget') opts.l3Budget = parseInt(args[++i]!);
    else if (a === '--merge-threshold') opts.mergeThreshold = parseInt(args[++i]!);
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Progress renderer
// ---------------------------------------------------------------------------

interface Spend {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

function renderProgress(
  strategy: AutobiographicalStrategy,
  startedAt: number,
  initialL1Queue: number,
  spend: Spend,
  isTty: boolean,
): void {
  const s = strategy.getProgressSnapshot();
  const elapsedMs = Date.now() - startedAt;
  const elapsedSec = elapsedMs / 1000;

  // Throughput: L1 chunks processed per second since start
  const l1Done = initialL1Queue - s.l1QueueLength;
  const l1Pct = initialL1Queue > 0 ? (l1Done / initialL1Queue) * 100 : 100;
  const throughput = l1Done > 0 ? l1Done / elapsedSec : 0;
  const remainingL1 = s.l1QueueLength;
  const etaSec = throughput > 0 ? remainingL1 / throughput : 0;

  const phase = s.l1QueueLength > 0 ? 'L1' : s.mergeQueueLength > 0 ? 'merges' : 'done';
  const line =
    `[${phase}] L1 ${l1Done}/${initialL1Queue} (${l1Pct.toFixed(1)}%) │ ` +
    `merges ${s.mergeQueueLength} queued │ ` +
    `L1/L2/L3 ${s.summaryCounts.l1}/${s.summaryCounts.l2}/${s.summaryCounts.l3} │ ` +
    `tok ${(spend.inputTokens / 1000).toFixed(0)}k in / ${(spend.outputTokens / 1000).toFixed(0)}k out │ ` +
    `$${spend.cost.toFixed(2)} │ ` +
    `${formatDuration(elapsedSec)} elapsed │ ` +
    `ETA ${formatDuration(etaSec)}`;

  if (isTty) {
    process.stderr.write(`\r\x1b[2K${line}`);
  } else {
    process.stderr.write(`${line}\n`);
  }
}

function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '?';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Chunk-target marker (beside the session, never inside the store)
// ---------------------------------------------------------------------------

function readTargetMarker(path: string): number | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { targetChunkTokens?: number };
    return typeof parsed.targetChunkTokens === 'number' ? parsed.targetChunkTokens : null;
  } catch {
    return null;
  }
}

function writeTargetMarker(path: string, target: number): void {
  try {
    writeFileSync(path, JSON.stringify({ targetChunkTokens: target }) + '\n');
  } catch (e) {
    console.error(`[warmup] could not record the chunk target beside the store: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  // Provider resolution: explicit flag wins; otherwise infer from the model id
  // so every existing invocation keeps its meaning.
  const bedrockModel = /^([a-z]{2,6}\.)?anthropic\./.test(opts.model);
  const provider = opts.provider !== 'anthropic'
    ? opts.provider
    : bedrockModel
      ? 'bedrock'
      : 'anthropic';
  const baseUrl = opts.baseUrl ?? process.env.OPENAI_COMPATIBLE_BASE_URL ?? null;

  if (provider === 'bedrock') {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      console.error('Bedrock model id — set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (and AWS_REGION)');
      process.exit(1);
    }
  } else if (provider === 'openai-compatible') {
    // A local server legitimately has no key, so only the endpoint is required.
    if (!baseUrl) {
      console.error('openai-compatible provider — pass --base-url or set OPENAI_COMPATIBLE_BASE_URL');
      process.exit(1);
    }
  } else if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY');
    process.exit(1);
  }

  const sessionMgr = new SessionManager(opts.dataDir);
  const session = sessionMgr.findSession(opts.sessionRef);
  if (!session) {
    console.error(`No session matching "${opts.sessionRef}" in ${opts.dataDir}`);
    process.exit(1);
  }
  const storePath = sessionMgr.getStorePath(session.id);

  const importSource = sessionMgr.getImportSource(session.id);
  const resolved = resolveAgentName({
    explicit: opts.agentName,
    sidecar: importSource?.agentName,
    default: 'Claude',
  });

  console.error(`Warming up session "${session.name}" (${session.id})`);
  console.error(`Store: ${storePath}`);
  console.error(`Agent: ${resolved.name} (${resolved.source})`);
  if (resolved.mismatch) {
    console.error(
      `WARNING: --agent "${resolved.mismatch.explicit}" overrides sidecar ` +
      `"${resolved.mismatch.sidecar}". Any summaries previously written under ` +
      `the sidecar name will be orphaned at agents/${resolved.mismatch.sidecar}/...`,
    );
  }
  const agentName = resolved.name;
  console.error(`Model: ${opts.model} (provider ${provider}${baseUrl ? ` @ ${baseUrl}` : ''})`);
  if (opts.maxSpend !== null) console.error(`Max spend: $${opts.maxSpend.toFixed(2)}`);

  // -- Membrane with token-spend hook --
  const price = priceOf(opts.model);
  const spend: Spend = { inputTokens: 0, outputTokens: 0, cost: 0 };
  // Bedrock model ids (anthropic.* / <region>.anthropic.*) route through the
  // BedrockAdapter with AWS_* env creds — legacy Claude models (revival
  // sessions) exist nowhere else. Caching off: legacy models reject
  // cache_control outright.
  const isBedrock = provider === 'bedrock';
  const adapter = provider === 'bedrock'
    ? new BedrockAdapter()
    : provider === 'openai-compatible'
      ? new OpenAICompatibleAdapter({
          baseURL: baseUrl!,
          apiKey: process.env.OPENAI_COMPATIBLE_API_KEY || undefined,
          providerName: 'openai-compatible',
        })
      : new AnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY });
  const membrane = new Membrane(adapter, {
    ...(isBedrock ? { defaultPromptCaching: false } : {}),
    // Imported sessions store assistant turns under participant `agentName`.
    // Membrane's default assistantParticipant is 'Claude'; if that disagrees
    // with the stored participant every assistant message maps to role
    // 'user' and the API rejects tool_use blocks.
    assistantParticipant: agentName,
    hooks: {
      afterResponse: (response: NormalizedResponse) => {
        const u = response.usage;
        if (u) {
          spend.inputTokens += u.inputTokens ?? 0;
          spend.outputTokens += u.outputTokens ?? 0;
          spend.cost =
            (spend.inputTokens * price.input + spend.outputTokens * price.output) / 1_000_000;
        }
        return response;
      },
    },
  });

  // -- Store + strategy + context manager --
  const store = JsStore.openOrCreate({ path: storePath });
  const strategy = new AutobiographicalStrategy({
    compressionModel: opts.model,
    // Autobio uses summaryParticipant for the synthetic summary messages it
    // writes back; aligning with the imported agent name keeps the whole
    // conversation under a single participant.
    summaryParticipant: agentName,
    autoTickOnNewMessage: false, // we drive ticks manually
    ...(opts.targetChunkTokens !== null && { targetChunkTokens: opts.targetChunkTokens }),
    ...(opts.l1Budget !== undefined && { l1BudgetTokens: opts.l1Budget }),
    ...(opts.l2Budget !== undefined && { l2BudgetTokens: opts.l2Budget }),
    ...(opts.l3Budget !== undefined && { l3BudgetTokens: opts.l3Budget }),
    ...(opts.mergeThreshold !== undefined && { mergeThreshold: opts.mergeThreshold }),
  });

  // Match AgentFramework.createAgent's namespace (`agents/${config.name}`)
  // so warmup writes summaries where the live agent reads them.
  const cm = await ContextManager.open({
    store,
    strategy,
    membrane,
    namespace: `agents/${agentName}`,
  });

  // Compression refuses to run when a chunk contains tool blocks and the host
  // has pushed no tool definitions ("deferring chunk compression: host has not
  // provided tool definitions yet"). A warm-runner has no live toolset, so
  // synthesise the names actually present in the history — the summarizer then
  // reads the same tool vocabulary the transcript uses.
  const toolNames = new Set<string>();
  for (const m of cm.getAllMessages()) {
    for (const b of (m.content ?? []) as Array<{ type?: string; name?: string }>) {
      if (b.type === 'tool_use' && typeof b.name === 'string') toolNames.add(b.name);
    }
  }
  if (toolNames.size > 0) {
    cm.setToolDefinitions(
      [...toolNames].map((name) => ({
        name,
        description: `Tool referenced in the imported history (${name}).`,
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
      })),
    );
    console.error(`Tools: ${toolNames.size} definitions synthesised from the history`);
  }

  // -- Inspect initial state --
  const initialStats = strategy.getProgressSnapshot();
  // A chunk size can only be chosen before the store is compressed: boundaries
  // are created on first open and are sticky, so a mismatched target would be
  // silently ignored — the cheapest-looking way to bill at the expensive rate.
  // The store records the target it was first opened with, beside the session.
  // Comparing against the request is the only way to tell a legitimate RESUME
  // (same target, more work to do) from a silently-ignored change of size —
  // refusing on "compressed chunks exist" alone blocked every resume.
  const targetMarkerPath = join(storePath, '..', `${session.id}.chunk-target.json`);
  const storedTarget = readTargetMarker(targetMarkerPath);
  if (opts.targetChunkTokens !== null && storedTarget !== null && storedTarget !== opts.targetChunkTokens) {
    console.error(
      `Refusing to warm: this store was chunked at ${storedTarget} tokens and chunk boundaries are ` +
      `sticky, so --target-chunk-tokens ${opts.targetChunkTokens} would be silently ignored. ` +
      `Re-import into a fresh directory to change the granularity.`,
    );
    process.exit(3);
  }
  if (storedTarget === null && initialStats.chunksCompressed === 0 && opts.targetChunkTokens !== null) {
    writeTargetMarker(targetMarkerPath, opts.targetChunkTokens);
  }
  const totalMessages = cm.getAllMessages().length;
  console.error(
    `\nInitial state: ${totalMessages} messages, ${initialStats.totalChunks} chunks total ` +
      `(${initialStats.chunksCompressed} already compressed, ${initialStats.l1QueueLength} pending L1, ` +
      `${initialStats.mergeQueueLength} merges pending).`,
  );
  if (initialStats.l1QueueLength === 0 && initialStats.mergeQueueLength === 0) {
    console.error('Nothing to do — already converged.\n');
    store.close?.();
    return;
  }
  console.error('');

  // -- Drive to convergence --
  const isTty = process.stderr.isTTY ?? false;
  const startedAt = Date.now();
  const initialL1Queue = initialStats.l1QueueLength;

  // Periodic progress refresh (handles long Sonnet calls so the bar doesn't
  // freeze between ticks).
  const renderTimer = setInterval(
    () => renderProgress(strategy, startedAt, initialL1Queue, spend, isTty),
    isTty ? 1000 : 30_000,
  );

  let aborted = false;
  try {
    while (true) {
      const stats = strategy.getProgressSnapshot();
      if (stats.l1QueueLength === 0 && stats.mergeQueueLength === 0) break;
      if (opts.maxSpend !== null && spend.cost >= opts.maxSpend) {
        aborted = true;
        break;
      }
      await cm.tick();
    }
  } finally {
    clearInterval(renderTimer);
    renderProgress(strategy, startedAt, initialL1Queue, spend, isTty);
    if (isTty) process.stderr.write('\n');
  }

  const finalStats = strategy.getProgressSnapshot();
  console.error('');
  if (aborted) {
    console.error(
      `Halted at $${spend.cost.toFixed(2)} (--max-spend $${opts.maxSpend?.toFixed(2)}). ` +
        `Re-run to resume — autobio state persists in Chronicle.`,
    );
  } else if (finalStats.l1QueueLength === 0 && finalStats.mergeQueueLength === 0) {
    console.error(
      `Converged. ${finalStats.summaryCounts.l1} L1 + ${finalStats.summaryCounts.l2} L2 + ${finalStats.summaryCounts.l3} L3 summaries. ` +
        `Total: ${spend.inputTokens.toLocaleString()} in / ${spend.outputTokens.toLocaleString()} out, $${spend.cost.toFixed(2)}.`,
    );
  } else {
    console.error(
      `Stopped with work remaining (L1=${finalStats.l1QueueLength}, merges=${finalStats.mergeQueueLength}). Re-run to continue.`,
    );
  }

  // "Converged" with nothing produced is a false green: the strategy defers
  // every chunk when it lacks tool definitions, then reports an empty queue.
  // A caller (especially a supervisor loop) must not read that as success.
  const produced = finalStats.summaryCounts.l1 + finalStats.summaryCounts.l2 + finalStats.summaryCounts.l3;
  if (produced === 0 && totalMessages > 0) {
    console.error(
      `ERROR: converged with ZERO summaries over ${totalMessages} messages — ` +
      `compression was deferred, not completed. Check the tool-definition and provider warnings above.`,
    );
    process.exit(4);
  }

  store.close?.();
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('\n', e);
    process.exit(1);
  });
}
