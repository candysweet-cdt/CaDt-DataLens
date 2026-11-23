import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
    AI_MASCOT_PHRASES, AI_MASCOT_PHRASE_ROTATE_MS, MASCOT_PHRASE_PHASES,
    mascotPhraseIndex, phrasesForPhase, randomMascotSalt,
} from '../../../src/ai/core/ai-mascot-phrases.js';

test('文案池：七组各 6 条，首句跨组不重复，漫游中只在 wait 出现', () => {
    assert.deepEqual([...MASCOT_PHRASE_PHASES].sort(), ['approval', 'ask', 'env', 'talk', 'think', 'tool', 'wait']);
    const firsts = [];
    for (const phase of MASCOT_PHRASE_PHASES) {
        const list = AI_MASCOT_PHRASES[phase];
        assert.equal(list.length, 6, `${phase} 应有 6 条`);
        assert.ok(list.every((s) => typeof s === 'string' && s.startsWith('甜澄')), `${phase} 文案应以甜澄开头`);
        firsts.push(list[0]);
    }
    assert.equal(new Set(firsts).size, firsts.length, '各组首句不能重复');
    const roam = MASCOT_PHRASE_PHASES.filter((p) => AI_MASCOT_PHRASES[p].includes('甜澄漫游中'));
    assert.deepEqual(roam, ['wait']);
});

test('mascotPhraseIndex：每 8 秒顺序推进一条，到末尾回绕', () => {
    const step = AI_MASCOT_PHRASE_ROTATE_MS;
    const got = [0, step, step * 2, step * 3, step * 4].map((t) => mascotPhraseIndex(t, 0, 4));
    assert.deepEqual(got, [0, 1, 2, 3, 0]);
    assert.equal(mascotPhraseIndex(step - 1, 0, 4), 0, '不足一个周期仍停在当前条');
    assert.equal(mascotPhraseIndex(step + 1, 0, 4), 1);
});

test('mascotPhraseIndex：开场偏移生效，负数/超大 salt 与非法入参安全回落', () => {
    assert.equal(mascotPhraseIndex(0, 2, 4), 2);
    assert.equal(mascotPhraseIndex(0, -1, 4), 3);
    assert.equal(mascotPhraseIndex(0, 7, 4), 3);
    assert.equal(mascotPhraseIndex(0, NaN, 4), 0);
    assert.equal(mascotPhraseIndex(0, 0, 0), 0);
    assert.equal(mascotPhraseIndex(0, 0, -3), 0);
    assert.equal(mascotPhraseIndex(-500, 0, 4), 0, '负 elapsed 视为 0');
    assert.equal(mascotPhraseIndex(NaN, 0, 4), 0);
});

test('mascotPhraseIndex：阶段切换只换池不重置基准，索引继续漂移', () => {
    const seq = [0, 1000, 9000, 17000, 25000].map((t) => mascotPhraseIndex(t, 0, 4));
    assert.deepEqual(seq, [0, 0, 1, 2, 3]);
});

test('randomMascotSalt：覆盖边界并落在 [0,len)', () => {
    assert.equal(randomMascotSalt(4, () => 0), 0);
    assert.equal(randomMascotSalt(4, () => 0.999), 3);
    assert.equal(randomMascotSalt(4, () => 1), 3, 'random 返回 1 时钳到末条');
    assert.equal(randomMascotSalt(4, () => NaN), 0);
    assert.equal(randomMascotSalt(0, () => 0.5), 0);
    for (let i = 0; i < 50; i++) {
        const s = randomMascotSalt(4, () => i / 50);
        assert.ok(s >= 0 && s < 4);
    }
});

test('phrasesForPhase：未知阶段回落 wait', () => {
    assert.equal(phrasesForPhase('nope'), AI_MASCOT_PHRASES.wait);
    assert.equal(phrasesForPhase('think'), AI_MASCOT_PHRASES.think);
});

test('接线：ai-panel.js 只从新模块取文案逻辑，不在本地重复定义且不写回 phaseAt', () => {
    const src = readFileSync(new URL('../../../src/ai/ai-panel.js', import.meta.url), 'utf8');
    assert.match(src, /from '\.\/core\/ai-mascot-phrases\.js'/);
    assert.doesNotMatch(src, /const AI_MASCOT_PHRASES\s*=/);
    assert.doesNotMatch(src, /AI_MASCOT_PHRASE_ROTATE_MS\s*=\s*30000/);
    assert.doesNotMatch(src, /dataset\.phaseAt/);
    assert.match(src, /dataset\.phraseSalt/);
    assert.match(src, /dataset\.phraseBaseAt/);
});

test('状态机：approval 拆成 approval/ask/env 三个独立分支，不再合并判定', () => {
    const src = readFileSync(new URL('../../../src/ai/ai-panel.js', import.meta.url), 'utf8');
    // 三个 pending Map 各自独立判定，不合并成 || 链
    assert.match(src, /pendingHere\(pendingApprovals\)\) return 'approval'/);
    assert.match(src, /pendingHere\(pendingAsks\)\) return 'ask'/);
    assert.match(src, /pendingHere\(pendingEnvCreations\)\) return 'env'/);
    // 旧的合并判定不应再出现
    assert.doesNotMatch(src, /pendingHere\(pendingApprovals\) \|\| pendingHere\(pendingAsks\)/);
});
