// ai-session-vacuum-parity.test.mjs：vacuum 状态机与 replaySessionLog 的双侧一致性测试（前端侧）。
// 夹具（fixtures/vacuum-parity.json）的 expect 数值由本文件断言，Go 侧
//（internal/sessionstore/vacuum_parity_test.go）断言同一份数值——任何一侧语义
// 漂移都会在这两个测试之一变红（docs/unfinished-plans/session-compaction-disk-growth.md §5.3 要点 3）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {replaySessionLog} from '../../src/ai/session/ai-session-store.js';

const fixturePath = new URL('./fixtures/vacuum-parity.json', import.meta.url);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

if (!Array.isArray(fixture.cases) || !fixture.cases.length) {
    throw new Error('vacuum-parity 夹具没有任何用例');
}

for (const c of fixture.cases) {
    test('vacuum-parity: ' + c.name, () => {
        // torn 用例按「无换行结尾」拼接（未提交尾行两侧都丢弃）。
        const text = c.lines.join('\n') + (c.expect.torn ? '' : '\n');
        const replay = replaySessionLog(text);
        assert.equal(replay.messages.length, c.expect.live, 'live 条数');
        assert.equal(replay.archived.length, c.expect.archived, 'archived 条数');
        assert.equal(replay.issues, c.expect.issues, 'issues 计数');
        assert.equal(replay.droppedTransient, c.expect.droppedTransient, 'droppedTransient 计数');
        assert.equal(replay.torn, c.expect.torn, 'torn 标记');
        const summary = replay.summary && replay.summary.text ? replay.summary.text : '';
        assert.equal(summary, c.expect.summary, '最终 summary');
        if (c.expect.archivedOrder) {
            assert.deepEqual(replay.archived.map((message) => message._mid), c.expect.archivedOrder,
                '归档序 = 重放序（时间序）');
        }
    });
}
