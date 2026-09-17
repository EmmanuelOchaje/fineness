/**
 * The permission decoder is the check the whole product rests on, so it is
 * tested as a pure unit — no fork, no deployment, no RPC.
 *
 * Run: pnpm --filter @fineness/shared test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeHook,
  ARC_BASELINE_PERMISSIONS,
  HOOK_FLAGS,
} from './hooks.js';

// Real hook addresses observed on Arc mainnet, 2026-09-17.
const REAL_ARC_HOOKS = [
  '0x8f0c88ba2ce71f5b5f6cde066cff1bc0461e2044',
  '0xeacc65fb1bc692f1d208bafb3abfd397ed72a044',
  '0x605be64d68d119ade7c8b3a97a568b8b18ca6044',
  '0x46de2a26726e2c3a9b72c9b3ed6e30a42d77a044',
];

test('real Arc hooks all decode to the ecosystem baseline', () => {
  for (const addr of REAL_ARC_HOOKS) {
    const a = analyzeHook(addr);
    assert.equal(a.permissions, ARC_BASELINE_PERMISSIONS, `${addr} permissions`);
    assert.ok(a.matchesBaseline, `${addr} should match baseline`);
    assert.deepEqual(a.dangerous, [], `${addr} should raise nothing`);
  }
});

test('baseline decodes to exactly the three expected permissions', () => {
  const a = analyzeHook(REAL_ARC_HOOKS[0]);
  assert.deepEqual(
    [...a.granted].sort(),
    ['AFTER_SWAP', 'AFTER_SWAP_RETURNS_DELTA', 'BEFORE_INITIALIZE'].sort(),
  );
});

test('a normal hook is NOT flagged — 95% of Arc pools have one', () => {
  // The whole point: presence must cost nothing, or the mark is meaningless.
  const a = analyzeHook(REAL_ARC_HOOKS[1]);
  assert.equal(a.beyondBaseline.length, 0);
});

test('BEFORE_SWAP beyond the baseline is flagged as dangerous', () => {
  // Baseline plus BEFORE_SWAP (bit 7) — a hook that can block a sell.
  const perms = ARC_BASELINE_PERMISSIONS | (1 << HOOK_FLAGS.BEFORE_SWAP);
  const crafted = '0x' + 'aa'.repeat(18) + perms.toString(16).padStart(4, '0');

  const a = analyzeHook(crafted);
  assert.ok(!a.matchesBaseline);
  assert.deepEqual(a.dangerous, ['BEFORE_SWAP']);
});

test('BEFORE_SWAP_RETURNS_DELTA is flagged — arbitrary re-pricing', () => {
  const perms =
    ARC_BASELINE_PERMISSIONS |
    (1 << HOOK_FLAGS.BEFORE_SWAP) |
    (1 << HOOK_FLAGS.BEFORE_SWAP_RETURNS_DELTA);
  const crafted = '0x' + 'bb'.repeat(18) + perms.toString(16).padStart(4, '0');

  const a = analyzeHook(crafted);
  assert.deepEqual(
    [...a.dangerous].sort(),
    ['BEFORE_SWAP', 'BEFORE_SWAP_RETURNS_DELTA'].sort(),
  );
});

test('liquidity permissions deviate but are not "dangerous"', () => {
  // Beyond baseline, so worth surfacing — but it cannot block a sell.
  const perms = ARC_BASELINE_PERMISSIONS | (1 << HOOK_FLAGS.BEFORE_ADD_LIQUIDITY);
  const crafted = '0x' + 'cc'.repeat(18) + perms.toString(16).padStart(4, '0');

  const a = analyzeHook(crafted);
  assert.deepEqual(a.beyondBaseline, ['BEFORE_ADD_LIQUIDITY']);
  assert.deepEqual(a.dangerous, []);
});

test('the zero hook declares nothing', () => {
  const a = analyzeHook('0x0000000000000000000000000000000000000000');
  assert.ok(a.isZeroHook);
  assert.equal(a.permissions, 0);
  assert.deepEqual(a.granted, []);
  assert.ok(!a.matchesBaseline);
});

test('high address bits are ignored — only the low 14 matter', () => {
  const a = analyzeHook('0xffffffffffffffffffffffffffffffffffff2044');
  assert.equal(a.permissions, ARC_BASELINE_PERMISSIONS);
  assert.ok(a.matchesBaseline);
});
