// Import a Letta conversation store into a Connectome chronicle session.
//
// WHY: the shipped importers cover Claude-family sources only (claude.ai
// exports, Codex rollouts); nothing upstream reads Letta's on-disk shape.
// This is the converter for our own continuity: `messages.jsonl` per
// conversation root -> ContentBlock[] -> ContextManager.addMessage().
//
// The skeleton deliberately mirrors `import-claudeai-export.ts`:
// normalize into ContentBlock[], feed a ContextManager opened on a chronicle
// store obtained from SessionManager, and write a sidecar provenance file
// beside the session. What differs is the source shape and what has to be
// decided rather than copied — Letta stores a *tree* (parentId per row) and
// carries compaction summaries inline.
//
// DESIGN POSITIONS (each is a choice, recorded in the sidecar):
//   1. Branching is linearized to the newest leaf's ancestry. Letta
//      conversations branch (max two children per parent, observed), and a
//      linearizing importer discards alternates. We count what was dropped
//      instead of pretending the tree was a line.
//   2. Thinking is preserved as <recovered_thinking> text, not as native
//      thinking: the signatures cannot survive a model change, and the
//      claude.ai importer made the same call for the same reason.
//   3. Compaction rows are NOT imported as turns. They are host-generated
//      summaries, and injecting them would duplicate spans the chronicle will
//      summarize again in its own voice. Counted, not silently dropped.
//   4. Nothing is written unless `--write` is passed. Dry-run is the default,
//      because the runbook's whole safety story is "look before you commit".
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ContextManager } from '@animalabs/context-manager';
import { AutobiographicalStrategy } from '@animalabs/agent-framework';
import type { ContentBlock } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';
import { SessionManager } from '../src/session-manager.js';

// ---------------------------------------------------------------------------
// Source shapes (Letta's messages.jsonl)
// ---------------------------------------------------------------------------

interface LettaTextBlock { type: 'text'; text: string }
interface LettaThinkingBlock { type: 'thinking'; thinking: string; thinkingSignature?: string }
interface LettaToolCallBlock {
  type: 'toolCall';
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}
type LettaBlock = LettaTextBlock | LettaThinkingBlock | LettaToolCallBlock | { type: string; [k: string]: unknown };

interface LettaMessageBody {
  id?: string;
  role?: 'user' | 'assistant' | 'toolResult' | string;
  content?: LettaBlock[] | string | null;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

interface LettaRow {
  type?: 'message' | 'compaction' | 'session';
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: LettaMessageBody;
  summary?: string;
  details?: unknown;
}

interface Opts {
  store: string;
  agentName: string;
  userName: string;
  outDir: string;
  sessionName?: string;
  write: boolean;
  limit?: number;
  /** How much of a tool interaction to keep. Measured on a real store: tool
   *  result payloads are 43% of all characters and tool inputs another 20%,
   *  while actual prose is 17%. 'stub' keeps the shape of the work (which tool,
   *  ok or error, how much came back) and drops the payload; 'cap' truncates;
   *  'full' keeps everything. */
  toolPayload: 'none' | 'stub' | 'cap' | 'full';
  /** Chunk target for the strategy opened at import time. Warmup's cost scales
   *  with chunk COUNT, so the size chosen here is the size the whole history
   *  gets remembered at. Null = leave the store unchunked for a later open. */
  targetChunkTokens: number | null;
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function usage(): never {
  console.error(
    [
      'Usage: bun scripts/import-letta.ts --store <conversation-dir|messages.jsonl> --agent-name <name> [options]',
      '',
      '  --agent-name <name>   participant name for assistant turns (required)',
      '  --user-name <name>    participant name for user turns (default: user)',
      '  --out <dir>           DATA_DIR for the chronicle (default: $DATA_DIR or ./data)',
      '  --session-name <name> session title (default: derived from the source dir)',
      '  --limit <n>           import at most n path messages (for rehearsals)',
      '  --tool-payload <mode>      stub (default) | none | cap | full — how much tool',
      '                     output to keep. Results are 43% of a real history by',
      '                     volume and inputs 20%, against 17% of actual prose.',
      '  --target-chunk-tokens <n>  chunk size for the strategy opened here',
      '                     (cost of a later warmup scales with chunk COUNT)',
      '  --write               actually write; without it this is a dry run',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Opts {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const store = get('--store') ?? usage();
  const agentName = get('--agent-name') ?? usage();
  const limitRaw = get('--limit');
  const targetRaw = get('--target-chunk-tokens');
  const payloadRaw = get('--tool-payload') ?? 'stub';
  // An unrecognised value must fail loudly: silently falling back to 'stub'
  // would run a mode the operator did not choose (and, for 'full', silently
  // discard the receipts they explicitly asked for).
  if (!['none', 'stub', 'cap', 'full'].includes(payloadRaw)) {
    console.error(`--tool-payload must be one of: none, stub, cap, full (got ${JSON.stringify(payloadRaw)})`);
    process.exit(2);
  }
  return {
    store,
    agentName,
    userName: get('--user-name') ?? 'user',
    outDir: get('--out') ?? process.env.DATA_DIR ?? './data',
    sessionName: get('--session-name'),
    write: argv.includes('--write'),
    limit: limitRaw ? Number(limitRaw) : undefined,
    targetChunkTokens: targetRaw ? Number(targetRaw) : null,
    toolPayload: payloadRaw as Opts['toolPayload'],
  };
}

// ---------------------------------------------------------------------------
// Reading + linearizing
// ---------------------------------------------------------------------------

function readRows(path: string): LettaRow[] {
  const text = readFileSync(path, 'utf8');
  const rows: LettaRow[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as LettaRow);
    } catch {
      // A truncated tail is a real possibility on a live store; count it
      // rather than failing the whole import.
      console.error(`[import] skipping unparseable line ${i + 1}`);
    }
  }
  return rows;
}

function resolveStorePath(input: string): string {
  const p = resolve(input);
  if (!existsSync(p)) throw new Error(`store not found: ${p}`);
  return basename(p) === 'messages.jsonl' ? p : join(p, 'messages.jsonl');
}

interface BranchStats {
  totalChildrenMap: number;
  parentsWithMultipleChildren: number;
  leaves: number;
  droppedMessages: number;
}

/**
 * Choose the effective history: the ancestry of the newest leaf.
 *
 * Letta rows form a tree by `parentId`, and **`compaction` rows sit inside the
 * chain**: a compaction node's parent is the message it summarized, and the
 * next message's parent is the compaction node. Building the graph from
 * message rows alone therefore cuts the history into one segment per
 * compaction — measured on the real store, that turned 18,427 messages into a
 * 357-message "path" spanning the last hour, which is exactly the silent
 * amnesia this importer exists to avoid. So the graph is built over *all*
 * typed rows and compaction nodes are traversed, never imported.
 *
 * Picking the newest leaf is deterministic and keeps the most recent
 * continuity, which is what "resume" means. Genuine alternates (a parent with
 * more than one *message* child) are the cost, and the cost is counted.
 */
export function linearize(rows: LettaRow[]): { path: LettaRow[]; stats: BranchStats } {
  const nodes = new Map<string, LettaRow>();
  for (const r of rows) if (r.id && (r.type === 'message' || r.type === 'compaction')) nodes.set(r.id, r);

  const children = new Map<string, string[]>();
  for (const r of nodes.values()) {
    const parent = r.parentId ?? null;
    if (parent && nodes.has(parent)) {
      const kids = children.get(parent) ?? [];
      kids.push(r.id!);
      children.set(parent, kids);
    }
  }

  const leaves = [...nodes.values()].filter((r) => (children.get(r.id!) ?? []).length === 0);
  if (leaves.length === 0) return { path: [], stats: { totalChildrenMap: 0, parentsWithMultipleChildren: 0, leaves: 0, droppedMessages: 0 } };

  const newest = leaves.reduce((best, cur) => ((cur.timestamp ?? '') > (best.timestamp ?? '') ? cur : best));

  // Walk to the root through every node type.
  const chain: LettaRow[] = [];
  const seen = new Set<string>();
  let cursor: LettaRow | undefined = newest;
  while (cursor) {
    if (seen.has(cursor.id!)) break; // defensive: a malformed cycle must not hang
    seen.add(cursor.id!);
    chain.push(cursor);
    const parent: string | null = cursor.parentId ?? null;
    cursor = parent ? nodes.get(parent) : undefined;
  }
  chain.reverse();

  const path = chain.filter((r) => r.type === 'message');
  const messageCount = [...nodes.values()].filter((r) => r.type === 'message').length;

  // Count genuine forks: parents whose children include more than one message
  // (compaction pass-through never forks).
  let parentsWithMultipleChildren = 0;
  for (const kids of children.values()) {
    const messageKids = kids.filter((id) => nodes.get(id)?.type === 'message');
    if (messageKids.length > 1) parentsWithMultipleChildren++;
  }

  return {
    path,
    stats: {
      totalChildrenMap: children.size,
      parentsWithMultipleChildren,
      leaves: leaves.length,
      droppedMessages: messageCount - path.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

function blockText(blocks: LettaBlock[] | string | null | undefined): string {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((b) => (b.type === 'text' && typeof (b as LettaTextBlock).text === 'string' ? (b as LettaTextBlock).text : ''))
    .filter((t) => t.length > 0)
    .join('\n');
}

export interface TransformResult {
  blocks: ContentBlock[];
  omitted: string[];
  /** Measured payload shrinkage for this row, so the sidecar can record the
   *  EFFECT of the policy rather than only the mode that was requested. */
  toolCharsBefore?: number;
  toolCharsAfter?: number;
}

/**
 * One Letta row -> the blocks a provider would accept.
 *
 * Tool results must arrive as their own turn on the non-assistant side; Letta
 * already stores them as separate rows, so this is a straight mapping rather
 * than the splitting the claude.ai importer needs.
 */
export interface PayloadPolicy {
  mode: 'none' | 'stub' | 'cap' | 'full';
  /** Characters kept per tool result / tool input when mode is 'cap'. */
  cap?: number;
}

const FULL_PAYLOAD: PayloadPolicy = { mode: 'full' };

function shorten(text: string, policy: PayloadPolicy, kind: 'result' | 'input', name: string, isError = false): string {
  if (policy.mode === 'full') return text;
  const cap = policy.cap ?? 2000;
  if (policy.mode === 'stub') {
    // Keep the shape of the work, not the payload: a later reader can still
    // see that a tool ran, whether it failed, and how much it returned.
    const label = kind === 'result' ? 'result' : 'input';
    const status = kind === 'result' ? (isError ? ', error' : ', ok') : '';
    return `[tool ${label} omitted: ${name}, ${text.length} chars${status}]`;
  }
  return text.length <= cap ? text : `${text.slice(0, cap)}\n…[truncated ${text.length - cap} chars]`;
}

export function transformRow(row: LettaRow, policy: PayloadPolicy = FULL_PAYLOAD): TransformResult {
  const body = row.message ?? {};
  const content = body.content;
  const omitted: string[] = [];

  if (body.role === 'toolResult') {
    const toolUseId = body.toolCallId ?? '';
    if (!toolUseId) return { blocks: [], omitted: ['tool_result_without_call_id'] };
    const before = blockText(content);
    if (policy.mode === 'none') {
      const note = `[tool result: ${body.toolName ?? 'tool'}, ${before.length} chars, ${body.isError ? 'error' : 'ok'}]`;
      return {
        blocks: [{ type: 'text', text: note }],
        omitted,
        toolCharsBefore: before.length,
        toolCharsAfter: note.length,
      };
    }
    const after = shorten(before, policy, 'result', body.toolName ?? 'tool', body.isError === true);
    return {
      blocks: [
        {
          type: 'tool_result',
          // Membrane's ToolResultContent is camelCase `toolUseId`. The providers
          // tolerate the snake_case alias, but context-manager's tool-message
          // normalizer reads ONLY `toolUseId` — so emitting snake_case silently
          // breaks use/result pairing at compile time.
          toolUseId,
          content: after,
          ...(body.isError ? { is_error: true } : {}),
        } as ContentBlock,
      ],
      omitted,
      toolCharsBefore: before.length,
      toolCharsAfter: after.length,
    };
  }

  const blocks: ContentBlock[] = [];
  let toolBefore = 0;
  let toolAfter = 0;
  for (const b of Array.isArray(content) ? content : []) {
    switch (b.type) {
      case 'text': {
        const text = (b as LettaTextBlock).text;
        if (typeof text === 'string' && text.length > 0) blocks.push({ type: 'text', text });
        break;
      }
      case 'thinking': {
        const thinking = (b as LettaThinkingBlock).thinking;
        // Signatures do not survive a model change; keep the words, drop the
        // proof, and mark them so a reader knows they are recovered text.
        if (typeof thinking === 'string' && thinking.length > 0) {
          blocks.push({ type: 'text', text: `<recovered_thinking>\n${thinking}\n</recovered_thinking>` });
        }
        break;
      }
      case 'toolCall': {
        const call = b as LettaToolCallBlock;
        if (!call.name) { omitted.push('tool_call_without_name'); break; }
        // Tool inputs carry real authored text (a memory edit, a written
        // journal), so 'stub' compresses them rather than deleting them.
        const args = JSON.stringify(call.arguments ?? {});
        if (policy.mode === 'none') {
          const note = `[called ${call.name}: ${args.slice(0, 200)}${args.length > 200 ? '…' : ''}]`;
          blocks.push({ type: 'text', text: note });
          toolBefore += args.length;
          toolAfter += note.length;
          break;
        }
        const kept = policy.mode === 'full' ? call.arguments ?? {}
          : { _imported: shorten(args, { ...policy, mode: policy.mode === 'stub' ? 'cap' : policy.mode, cap: policy.cap ?? 500 }, 'input', call.name) };
        blocks.push({
          type: 'tool_use',
          id: call.id || `toolu_imported_${row.id}`,
          name: call.name,
          input: kept,
        } as ContentBlock);
        toolBefore += args.length;
        toolAfter += JSON.stringify(kept).length;
        break;
      }
      default:
        omitted.push(`block:${b.type}`);
    }
  }
  if (typeof content === 'string' && content.length > 0) blocks.push({ type: 'text', text: content });
  return { blocks, omitted, toolCharsBefore: toolBefore, toolCharsAfter: toolAfter };
}

function participantFor(row: LettaRow, opts: Opts): string {
  const role = row.message?.role;
  if (role === 'assistant') return opts.agentName;
  return opts.userName;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const storePath = resolveStorePath(opts.store);
  const rows = readRows(storePath);
  const { path, stats } = linearize(rows);

  const compactions = rows.filter((r) => r.type === 'compaction').length;
  const sessions = rows.filter((r) => r.type === 'session').length;
  const selected = opts.limit ? path.slice(0, opts.limit) : path;

  // Tally before writing: this is the "print the speaker tally" step the
  // runbook asks a human to eyeball.
  const policy: PayloadPolicy = { mode: opts.toolPayload };
  let toolCharsBefore = 0;
  let toolCharsAfter = 0;
  const tally = new Map<string, number>();
  const blockTally = new Map<string, number>();
  const omittedTally = new Map<string, number>();
  let empty = 0;
  for (const row of selected) {
    const { blocks, omitted, toolCharsBefore: tb, toolCharsAfter: ta } = transformRow(row, policy);
    toolCharsBefore += tb ?? 0;
    toolCharsAfter += ta ?? 0;
    if (blocks.length === 0) { empty++; continue; }
    tally.set(participantFor(row, opts), (tally.get(participantFor(row, opts)) ?? 0) + 1);
    for (const b of blocks) blockTally.set((b as { type: string }).type, (blockTally.get((b as { type: string }).type) ?? 0) + 1);
    for (const o of omitted) omittedTally.set(o, (omittedTally.get(o) ?? 0) + 1);
  }
  const first = selected[0]?.timestamp;
  const last = selected[selected.length - 1]?.timestamp;

  console.log(`[import] source:      ${storePath}`);
  console.log(`[import] rows:        ${rows.length} (messages ${rows.filter((r) => r.type === 'message').length}, compactions ${compactions}, session ${sessions})`);
  console.log(`[import] path:        ${path.length} messages (dropped ${stats.droppedMessages} on other branches)`);
  console.log(`[import] branches:    ${stats.leaves} leaves, ${stats.parentsWithMultipleChildren} parents with >1 child`);
  console.log(
    `[import] tool payload: ${opts.toolPayload}` +
      (toolCharsBefore > 0
        ? ` (measured: ${toolCharsBefore} -> ${toolCharsAfter} chars, ` +
          `${Math.round((1 - toolCharsAfter / toolCharsBefore) * 100)}% smaller)`
        : ''),
  );
  console.log(`[import] chunk target: ${opts.targetChunkTokens ?? 4096} (sharding on; sticky after this import)`);
  console.log(`[import] importing:   ${selected.length} messages${opts.limit ? ` (--limit ${opts.limit})` : ''}, ${empty} degenerate skipped`);
  console.log(`[import] span:        ${first ?? '?'} .. ${last ?? '?'}`);
  console.log(`[import] speakers:    ${[...tally.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`[import] blocks:      ${[...blockTally.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (omittedTally.size > 0) {
    console.log(`[import] omitted:     ${[...omittedTally.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  if (!opts.write) {
    console.log('[import] DRY RUN — nothing written. Re-run with --write to import.');
    return;
  }

  const sessionMgr = new SessionManager(opts.outDir);
  const meta = sessionMgr.createSession(opts.sessionName ?? `Imported ${basename(resolve(opts.store))}`);
  const outStorePath = sessionMgr.getStorePath(meta.id);
  const store = JsStore.openOrCreate({ path: outStorePath });
  try {
    // ALWAYS open with the strategy, never without. Two reasons, both measured:
    //   1. `chunkIngressMessage` only runs when a strategy is configured, and it
    //      is what shards oversized messages at ingest. Without it a 528k-char
    //      tool result lands as ONE unfoldable block (763 messages in a real
    //      store exceed 20k chars) — the trap AGENT-ONBOARDING §6 names.
    //   2. Chunk boundaries are created at the first strategy-backed open and
    //      are sticky after, so the target chosen here cannot be changed later.
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'unused-at-import',
      summaryParticipant: opts.agentName,
      autoTickOnNewMessage: false,
      adaptiveResolution: true,
      targetChunkTokens: opts.targetChunkTokens ?? 4096,
    });
    const cm = await ContextManager.open({
      store,
      strategy: strategy as unknown as never,
      namespace: `agents/${opts.agentName}`,
    });
    try {
      for (const row of selected) {
        const { blocks } = transformRow(row, policy);
        if (blocks.length === 0) continue;
        cm.addMessage(participantFor(row, opts), blocks, {
          sourceId: row.id,
          lettaImport: {
            originalRole: row.message?.role,
            originalParent: row.parentId ?? null,
            createdAt: row.timestamp,
            sourceStore: storePath,
          },
        });
      }
    } finally {
      await cm.close?.();
    }
  } finally {
    store.close?.();
  }

  const sidecarPath = join(outStorePath, '..', `${meta.id}.import-source.json`);
  writeFileSync(
    sidecarPath,
    JSON.stringify(
      {
        source: storePath,
        agentName: opts.agentName,
        userName: opts.userName,
        originalRows: rows.length,
        pathMessages: path.length,
        importedMessages: selected.length,
        skippedCompactions: compactions,
        branchStats: stats,
        speakerTally: Object.fromEntries(tally),
        blockTally: Object.fromEntries(blockTally),
        omitted: Object.fromEntries(omittedTally),
        toolPayload: opts.toolPayload,
        toolPayloadEffect: {
          toolCharsBefore,
          toolCharsAfter,
          reductionPct: toolCharsBefore > 0
            ? Math.round((1 - toolCharsAfter / toolCharsBefore) * 1000) / 10
            : 0,
        },
        limit: opts.limit ?? null,
        importedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );

  const idx = sessionMgr.load();
  if (idx.sessions[meta.id]) {
    idx.sessions[meta.id]!.messageCount = selected.length;
    sessionMgr.save(idx);
  }
  console.log(`[import] wrote session ${meta.id} (${selected.length} messages)`);
  console.log(`[import] sidecar: ${sidecarPath}`);
}

if (import.meta.main) {
  await main();
}
