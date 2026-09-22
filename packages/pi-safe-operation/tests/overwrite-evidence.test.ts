import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareJudgeEvidence } from '../src/judge-evidence.ts';
import { judgeRequestFromEvent } from '../src/judge.ts';
const identity = (text: string) => text;
for (const [name, original, proposed, allowed] of [
  ['exact original byte budget', 'x'.repeat(16000), 'new', true],
  ['over original byte budget', 'x'.repeat(16001), 'new', false],
  ['multibyte original fits', '中'.repeat(5333), 'new', true],
  ['multibyte original exceeds', '中'.repeat(5334), 'new', false],
  ['exact proposed character budget', 'old', 'x'.repeat(12000), true],
  ['over proposed character budget', 'old', 'x'.repeat(12001), false],
  ['empty original is complete', '', 'new', true],
  ['empty replacement is complete evidence', 'old', '', true],
  ['binary original is unavailable', 'old\0binary', 'new', false],
] as const) {
  test(`overwrite evidence: ${name}`, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'overwrite-budget-'));
    try {
      fs.writeFileSync(path.join(cwd, 'file.txt'), original);
      const event = { toolName: 'write', input: { path: 'file.txt', content: proposed } };
      const request = judgeRequestFromEvent(event, {}, identity);
      const evidence = prepareJudgeEvidence({ event, request, ctx: { cwd }, explicitTargets: [],
        protectedPaths: [], knowledgeDirs: [], redact: identity, resolveTarget: target => path.resolve(cwd, target),
        mayRead: () => true, gitStatus: async () => 'unknown' });
      const blocked = await evidence.prepareOverwrite();
      assert.equal(blocked === undefined, allowed);
      assert.equal(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8'), original);
      if (allowed) {
        assert.equal((request.evidence!.current_content as any[])[0].text, original);
        assert.equal((request.evidence!.overwriteReview as any).complete, true);
      } else assert.match(blocked!, /auto-judge:need_evidence/);
      assert.equal(evidence.isFresh(), true);
      fs.appendFileSync(path.join(cwd, 'file.txt'), 'concurrent');
      assert.equal(evidence.isFresh(), false);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
}

test('overwrite refuses symlink leaves and invalid UTF-8, without reading a sensitive target', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'overwrite-read-boundary-'));
  try {
    fs.writeFileSync(path.join(cwd, 'target.txt'), 'original');
    fs.writeFileSync(path.join(cwd, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
    try { fs.symlinkSync(path.join(cwd, 'target.txt'), path.join(cwd, 'link.txt')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Symlinks require permission on Windows'); return; } throw error; }
    for (const target of ['target.txt', 'invalid.txt', 'link.txt']) {
      const event = { toolName: 'write', input: { path: target, content: 'new' } };
      const request = judgeRequestFromEvent(event, {}, identity);
      const evidence = prepareJudgeEvidence({ event, request, ctx: { cwd }, explicitTargets: [],
        protectedPaths: [], knowledgeDirs: [], redact: identity, resolveTarget: p => path.resolve(cwd, p),
        mayRead: p => path.basename(p) !== 'target.txt', gitStatus: async () => 'unknown' });
      assert.match((await evidence.prepareOverwrite())!, /auto-judge:need_evidence/);
      assert.equal((request.evidence!.current_content as any[])[0].text, undefined);
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
