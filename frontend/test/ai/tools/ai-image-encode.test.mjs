// ai-image-encode 单测：图片载荷编码是「输入框附加图片」与 read_image 工具共用的单一实现，
// 这里锁住纯函数（扩展名判定 / 等比缩放 / 预算降质策略）与画布注入接口。
// DOM 相关部分（Image / createImageBitmap）在 Node 里没有，只用「不触 DOM 的失败路径」验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    drawImagePayload,
    encodeCanvasPayload,
    fitImageSize,
    isReadableImagePath,
    prepareImagePayload,
} from '../../../src/ai/tools/ai-image-encode.js';

// 假画布：toDataURL 交给 handler 决定返回什么，便于驱动 png → jpeg 降质分支
function makeCanvas(handler, opts) {
    const options = opts || {};
    const calls = [];
    return {
        calls,
        width: 0,
        height: 0,
        getContext: () => (options.noContext ? null : {
            drawImage: (...args) => calls.push(['drawImage', ...args]),
        }),
        toDataURL: (type, quality) => {
            calls.push(['toDataURL', type, quality]);
            return handler(type, quality);
        },
    };
}

test('isReadableImagePath：与后端 ReadImageAsDataURL 的扩展名表一致', () => {
    for (const path of ['a.png', 'a.PNG', 'b.jpg', 'b.JPEG', 'c.gif', 'd.webp', 'e.bmp', 'f.svg']) {
        assert.equal(isReadableImagePath(path), true, path + ' 应判定为图片');
    }
    for (const path of ['a.txt', 'a.md', 'a.pngx', 'png', '', null, 'dir/png']) {
        assert.equal(isReadableImagePath(path), false, String(path) + ' 不应判定为图片');
    }
});

test('fitImageSize：长边超限才缩，永不放大，宽高未知按上限兜底', () => {
    assert.deepEqual(fitImageSize(4000, 2000, 1600), {width: 1600, height: 800, scale: 0.4});
    assert.deepEqual(fitImageSize(800, 600, 1600), {width: 800, height: 600, scale: 1});
    assert.deepEqual(fitImageSize(2000, 3000, 1500), {width: 1000, height: 1500, scale: 0.5});
    // svg 无固有尺寸时 width/height 为 0：回落到上限方框，避免 NaN 画布
    assert.deepEqual(fitImageSize(0, 0, 1600), {width: 1600, height: 1600, scale: 1});
    assert.deepEqual(fitImageSize(0, 1200, 1600), {width: 1, height: 1200, scale: 1});
    // 极小值不会算出 0 宽高
    assert.equal(fitImageSize(3, 10000, 100).width, 1);
});

test('encodeCanvasPayload：预算内保持 PNG 原样', () => {
    const canvas = makeCanvas(() => 'data:image/png;base64,' + 'A'.repeat(100));
    const payload = encodeCanvasPayload(canvas, 1000);
    assert.equal(payload.mime, 'image/png');
    assert.equal(payload.data, 'A'.repeat(100));
    assert.equal(payload.bytes, 75);
});

test('encodeCanvasPayload：超预算转 JPEG 并逐级降质直到进预算', () => {
    const qualities = [];
    const canvas = makeCanvas((type, quality) => {
        if (type === 'image/png') return 'data:image/png;base64,' + 'A'.repeat(5000);
        qualities.push(quality);
        // 质量 ≤0.5 时才降到预算内，验证循环确实在降
        return quality <= 0.5
            ? 'data:image/jpeg;base64,' + 'B'.repeat(200)
            : 'data:image/jpeg;base64,' + 'B'.repeat(5000);
    });
    const payload = encodeCanvasPayload(canvas, 1000);
    assert.equal(payload.mime, 'image/jpeg');
    assert.equal(payload.data, 'B'.repeat(200));
    assert.ok(qualities.length >= 3, '应多次降质尝试，实际：' + qualities.length);
    assert.ok(qualities[qualities.length - 1] <= 0.5, '最后一次质量应已降到 0.5 以下');
    assert.ok(qualities[0] < 1, '首次尝试不应是默认质量');
});

test('encodeCanvasPayload：压不下去与编码失败各自报错', () => {
    const tooLarge = makeCanvas(() => 'data:image/png;base64,' + 'A'.repeat(5000));
    assert.throws(() => encodeCanvasPayload(tooLarge, 1000), /压缩后图片仍然过大/);
    const broken = makeCanvas(() => 'data:image/png;base64');
    assert.throws(() => encodeCanvasPayload(broken, 1000), /图片编码失败/);
});

test('drawImagePayload：按长边缩放后画到画布，name 原样透传', () => {
    const canvas = makeCanvas(() => 'data:image/png;base64,' + 'C'.repeat(40));
    const seen = [];
    const payload = drawImagePayload({tag: 'bitmap'}, 3200, 1600, {
        maxDim: 1600,
        maxBase64: 1000,
        name: 'shot.png',
        createCanvas: (w, h) => {
            seen.push([w, h]);
            canvas.width = w;
            canvas.height = h;
            return canvas;
        },
    });
    assert.deepEqual(seen, [[1600, 800]]);
    const draw = canvas.calls.find((call) => call[0] === 'drawImage');
    assert.deepEqual(draw.slice(1), [{tag: 'bitmap'}, 0, 0, 1600, 800]);
    assert.equal(payload.width, 1600);
    assert.equal(payload.height, 800);
    assert.equal(payload.name, 'shot.png');
    assert.equal(payload.mime, 'image/png');
});

test('drawImagePayload：拿不到 2d 上下文时明确报错', () => {
    assert.throws(() => drawImagePayload({}, 10, 10, {
        createCanvas: (w, h) => makeCanvas(() => '', {noContext: true}),
    }), /无法创建图片画布/);
});

test('prepareImagePayload：空数据与非图片串直接拒绝，不触 DOM', async () => {
    await assert.rejects(() => prepareImagePayload(null), /没有图片数据/);
    await assert.rejects(() => prepareImagePayload(''), /不是有效的图片数据/);
    await assert.rejects(() => prepareImagePayload('/tmp/a.png'), /不是有效的图片数据/);
});

test('prepareImagePayload：Blob 超体积上限时按配置报错（在解码前拦掉）', async () => {
    const blob = {arrayBuffer: async () => new ArrayBuffer(0), size: 3 * 1024 * 1024, type: 'image/png'};
    await assert.rejects(
        () => prepareImagePayload(blob, {maxInputBytes: 2 * 1024 * 1024}),
        /图片超过 2MB/,
    );
});
