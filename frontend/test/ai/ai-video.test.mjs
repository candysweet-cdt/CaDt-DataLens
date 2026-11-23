// ai-video.test.mjs：视频附件链路的纯函数——aiNormalizeVideo / aiVideoFromSrc /
// bufferToBase64 / isReadableVideoPath（ai-constants.js）与 ai-session-store 的
// safeVideoName / serializeSessionMessage videos 落盘引用（丢 base64 留 file）。
// DOM 相关的编解码入口在 ai-composer（不可直测），门禁行为由 ai-tool-defs / wiring 守卫兜底。
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    AI_VIDEO_ESTIMATE_TOKENS,
    AI_VIDEO_LIMIT,
    AI_VIDEO_MAX_INPUT_BYTES,
    AI_VIDEO_MAX_BASE64,
    aiNormalizeVideo,
    aiVideoFromSrc,
    bufferToBase64,
    isReadableVideoPath,
    aiEstimateVideoTokens,
} from '../../src/ai/core/ai-constants.js';
import {safeVideoName, serializeSessionMessage} from '../../src/ai/session/ai-session-store.js';

test('isReadableVideoPath：只认 .mp4，其他容器拒绝', () => {
    assert.equal(isReadableVideoPath('D:/a/b/clip.mp4'), true);
    assert.equal(isReadableVideoPath('clip.MP4'), true);
    assert.equal(isReadableVideoPath('clip.webm'), false);
    assert.equal(isReadableVideoPath('clip.mov'), false);
    assert.equal(isReadableVideoPath('clip.avi'), false);
    assert.equal(isReadableVideoPath(''), false);
    assert.equal(isReadableVideoPath(null), false);
});

test('aiNormalizeVideo：mime 白名单 / 超上限拒绝 / file 引用保留', () => {
    assert.equal(aiNormalizeVideo({mime: 'video/webm', data: 'AAAA'}), null, 'webm 不在白名单');
    assert.equal(aiNormalizeVideo({mime: 'video/mp4', data: ''}), null, '无 data 且无 file 引用');
    assert.equal(aiNormalizeVideo({mime: 'video/mp4', data: 'A'.repeat(AI_VIDEO_MAX_BASE64 + 1)}), null, '超 base64 上限');
    const ok = aiNormalizeVideo({mime: 'video/mp4', data: ' AA AA ', name: '演示.mp4', bytes: 3});
    assert.ok(ok);
    assert.equal(ok.mime, 'video/mp4');
    assert.equal(ok.data, 'AAAA', '空白会被去掉');
    assert.equal(ok.name, '演示.mp4');
    assert.equal(ok.bytes, 3);
    assert.match(ok.id, /^vid-/);
    // 只有 file 引用（已落盘）也放行：历史会话重放不丢视频
    const ref = aiNormalizeVideo({mime: 'video/mp4', file: 'videos/vid-1.mp4'});
    assert.ok(ref);
    assert.equal(ref.data, '');
    assert.equal(ref.file, 'videos/vid-1.mp4');
});

test('aiVideoFromSrc：data URL 解析 + 大小上限 + 非 video mime 拒绝', () => {
    assert.equal(aiVideoFromSrc('不是 data URL'), null);
    assert.equal(aiVideoFromSrc('data:image/png;base64,AAAA'), null, '图片 mime 不进视频通道');
    const parsed = aiVideoFromSrc('data:video/mp4;base64,QQ==', 'clip.mp4');
    assert.ok(parsed);
    assert.equal(parsed.data, 'QQ==');
    assert.equal(parsed.bytes, 3, '按 base64 长度名义换算（不抠 padding，估大小够用）');
    assert.equal(parsed.name, 'clip.mp4');
    assert.equal(aiVideoFromSrc('data:video/mp4;base64,' + 'A'.repeat(AI_VIDEO_MAX_BASE64 + 1)), null, '超上限返回 null');
});

test('bufferToBase64：分块转换与 btoa 一致（含超过 0x8000 的输入）', () => {
    assert.equal(bufferToBase64(new Uint8Array([1, 2, 3]).buffer), btoa(String.fromCharCode(1, 2, 3)));
    const big = new Uint8Array(0x8000 * 2 + 7);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    let expected = '';
    for (let i = 0; i < big.length; i++) expected += String.fromCharCode(big[i]);
    assert.equal(bufferToBase64(big.buffer), btoa(expected));
});

test('aiEstimateVideoTokens 返回固定估算值', () => {
    assert.equal(aiEstimateVideoTokens(), AI_VIDEO_ESTIMATE_TOKENS);
});

test('视频常量与 Go 侧对齐（文件 16 MB / base64 24 MB / 每消息 1 个）', () => {
    assert.equal(AI_VIDEO_MAX_INPUT_BYTES, 16 * 1024 * 1024);
    assert.equal(AI_VIDEO_MAX_BASE64, 24 * 1024 * 1024);
    assert.equal(AI_VIDEO_LIMIT, 1);
});

test('safeVideoName：mp4 扩展名、非法字符收敛', () => {
    assert.equal(safeVideoName({id: 'vid-1', mime: 'video/mp4'}), 'vid-1.mp4');
    assert.equal(safeVideoName({id: 'v/1 x', mime: 'video/mp4'}), 'v_1_x.mp4');
    assert.equal(safeVideoName({mime: 'video/mp4'}), 'vid.mp4', '无 id 用默认 vid');
    assert.equal(safeVideoName({id: 'x', mime: 'video/unknown'}), 'x.mp4', '未知 mime 仍落 mp4');
});

test('serializeSessionMessage：videos 已落盘时丢 base64 只留 file 引用', () => {
    const message = {
        role: 'user',
        content: '看这个',
        videos: [{id: 'vid-1', mime: 'video/mp4', data: 'QQ==', name: 'c.mp4', file: 'videos/vid-1.mp4'}],
    };
    const out = serializeSessionMessage(message);
    assert.equal(out.videos.length, 1);
    assert.equal(out.videos[0].file, 'videos/vid-1.mp4');
    assert.equal(out.videos[0].data, undefined, '有 file 引用时不再内嵌 base64');

    const fallback = serializeSessionMessage({
        role: 'user',
        content: '',
        videos: [{id: 'vid-2', mime: 'video/mp4', data: 'QQ==', name: 'd.mp4'}],
    });
    assert.equal(fallback.videos[0].data, 'QQ==', '落盘失败退回内嵌，宁可撑大不丢视频');
});
