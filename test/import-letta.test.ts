import { describe, test, expect } from 'bun:test';
import { linearize, transformRow } from '../scripts/import-letta.js';

// These pin the two decisions that are easy to get subtly wrong and
// impossible to notice afterwards:
//   1. compaction nodes sit *inside* the parent chain, so a graph built from
//      message rows alone cuts the history into one segment per compaction —
//      measured on a real store, that turned 18 427 messages into 357, i.e.
//      "my whole history" silently became "the last hour";
//   2. a fork must be counted, not smoothed away, because the number is the
//      only evidence that the import lost alternates.

type Row = Parameters<typeof linearize>[0][number];

const msg = (id: string, parentId: string | null, ts: string, role = 'user'): Row => ({
  type: 'message',
  id,
  parentId,
  timestamp: ts,
  message: { role, content: [{ type: 'text', text: id }] },
});

const compaction = (id: string, parentId: string | null, ts: string): Row => ({
  type: 'compaction',
  id,
  parentId,
  timestamp: ts,
  message: { role: 'user', content: [] },
});

describe('linearize', () => {
  test('walks through compaction nodes instead of stopping at them', () => {
    const rows: Row[] = [
      msg('a', null, '2026-01-01T00:00:00Z'),
      msg('b', 'a', '2026-01-01T00:01:00Z', 'assistant'),
      compaction('c1', 'b', '2026-01-01T00:02:00Z'),
      msg('d', 'c1', '2026-01-01T00:03:00Z'),
      msg('e', 'd', '2026-01-01T00:04:00Z', 'assistant'),
      compaction('c2', 'e', '2026-01-01T00:05:00Z'),
      msg('f', 'c2', '2026-01-01T00:06:00Z'),
    ];
    const { path, stats } = linearize(rows);
    expect(path.map((r) => r.id)).toEqual(['a', 'b', 'd', 'e', 'f']);
    expect(stats.droppedMessages).toBe(0);
    expect(stats.leaves).toBe(1);
  });

  test('picks the newest leaf and counts what the other branches cost', () => {
    const rows: Row[] = [
      msg('a', null, '2026-01-01T00:00:00Z'),
      msg('b', 'a', '2026-01-01T00:01:00Z'), // fork point
      msg('b1', 'b', '2026-01-01T00:02:00Z'), // the alternate
      msg('b2', 'b', '2026-01-01T00:03:00Z'), // the path taken
    ];
    const { path, stats } = linearize(rows);
    expect(path.map((r) => r.id)).toEqual(['a', 'b', 'b2']);
    expect(stats.parentsWithMultipleChildren).toBe(1);
    expect(stats.droppedMessages).toBe(1);
  });

  test('a compaction whose children are all compaction is not a fork', () => {
    const rows: Row[] = [
      msg('a', null, '2026-01-01T00:00:00Z'),
      compaction('c1', 'a', '2026-01-01T00:01:00Z'),
      msg('b', 'c1', '2026-01-01T00:02:00Z'),
      compaction('c2', 'b', '2026-01-01T00:03:00Z'),
      msg('c', 'c2', '2026-01-01T00:04:00Z'),
    ];
    const { stats } = linearize(rows);
    expect(stats.parentsWithMultipleChildren).toBe(0);
  });
});

describe('transformRow — tool payload policy', () => {
  const bigResult: Row = {
    type: 'message',
    id: 'r9',
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    message: {
      role: 'toolResult',
      toolCallId: 'tool_big',
      toolName: 'Bash',
      content: [{ type: 'text', text: 'x'.repeat(50_000) }],
    },
  };

  test('stub keeps the shape of the work and drops the payload', () => {
    const { blocks } = transformRow(bigResult, { mode: 'stub' });
    const text = (blocks[0] as { content: string }).content;
    expect(text.length).toBeLessThan(120);
    expect(text).toContain('Bash');
    expect(text).toContain('50000 chars');
    expect(text).toContain('ok');
  });

  test('stub still marks a failed result as an error', () => {
    const failed = { ...bigResult, message: { ...bigResult.message, isError: true } };
    const { blocks } = transformRow(failed as Row, { mode: 'stub' });
    expect((blocks[0] as { content: string }).content).toContain('error');
    expect((blocks[0] as { is_error?: boolean }).is_error).toBe(true);
  });

  test('full keeps the payload intact', () => {
    const { blocks } = transformRow(bigResult, { mode: 'full' });
    expect((blocks[0] as { content: string }).content.length).toBe(50_000);
  });

  test('stub compresses a tool input instead of deleting it', () => {
    const row: Row = {
      type: 'message',
      id: 'a9',
      parentId: null,
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 't1', name: 'memory', arguments: { command: 'create', content: 'y'.repeat(9000) } }],
      },
    };
    const { blocks } = transformRow(row, { mode: 'stub' });
    const input = (blocks[0] as { input: Record<string, unknown> }).input;
    expect(typeof input._imported).toBe('string');
    expect((input._imported as string).length).toBeLessThan(700);
    expect(input._imported as string).toContain('truncated');
  });
});

describe('transformRow', () => {
  test('a toolResult row becomes a tool_result block on the non-assistant side', () => {
    const row: Row = {
      type: 'message',
      id: 'r1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'toolResult',
        toolCallId: 'tool_abc',
        isError: true,
        content: [{ type: 'text', text: 'boom' }],
      },
    };
    const { blocks } = transformRow(row);
    expect(blocks).toEqual([
      { type: 'tool_result', toolUseId: 'tool_abc', content: 'boom', is_error: true },
    ]);
  });

  test('a toolResult with no call id is refused rather than exported as an orphan', () => {
    const row: Row = {
      type: 'message',
      id: 'r2',
      parentId: null,
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'toolResult', content: [{ type: 'text', text: 'x' }] },
    };
    const { blocks, omitted } = transformRow(row);
    expect(blocks).toEqual([]);
    expect(omitted).toContain('tool_result_without_call_id');
  });

  test('thinking is preserved as recovered text, not as a native thinking block', () => {
    const row: Row = {
      type: 'message',
      id: 'a1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'I should be careful.' }],
      },
    };
    const { blocks } = transformRow(row);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'text',
      text: '<recovered_thinking>\nI should be careful.\n</recovered_thinking>',
    });
  });
});
