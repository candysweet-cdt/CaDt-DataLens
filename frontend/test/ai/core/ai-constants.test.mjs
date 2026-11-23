// ai-constants.test.mjs：正文图片 data URL 反解（aiImageFromSrc）与 aiImageSrc 的往返，
// 以及正文图片引用失效时的会话附图兜底查找（aiFindAttachedImageByRef）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {aiCtxBannerShow, aiCtxBannerState, aiFindAttachedImageByRef, aiFormatBytes, aiFormatDuration, aiFormatLiveDuration, aiImageExt, aiImageFromSrc, aiImageSrc, aiIsContextOverflowError, aiMsgActionsStepMode, APPROVAL_LOST_TEXT, ASK_LOST_TEXT, ENV_ASK_LOST_TEXT, TOOL_INTERRUPTED_TEXT} from '../../../src/ai/core/ai-constants.js';

test('aiImageFromSrc: 与 aiImageSrc 往返一致', () => {
    const image = aiImageFromSrc('data:image/png;base64,AAAA', 'seal.png');
    assert.deepEqual(image, {mime: 'image/png', data: 'AAAA', name: 'seal.png'});
    assert.equal(aiImageSrc(image), 'data:image/png;base64,AAAA');
});

test('aiImageFromSrc: mime 归一与空白剔除', () => {
    assert.equal(aiImageFromSrc('data:image/jpeg;base64, AA\r\nAA ', 'x').mime, 'image/jpeg');
    assert.equal(aiImageFromSrc('data:IMAGE/JPG;base64,AA', 'x').mime, 'image/jpeg');
    assert.equal(aiImageFromSrc('data:image/png;base64,AA AA', 'x').data, 'AAAA');
    assert.equal(aiImageExt(aiImageFromSrc('data:image/jpeg;base64,AA', 'x').mime), 'jpg');
});

test('aiImageFromSrc: 名称缺省为「图片」', () => {
    assert.equal(aiImageFromSrc('data:image/png;base64,AA', '').name, '图片');
    assert.equal(aiImageFromSrc('data:image/png;base64,AA', '   ').name, '图片');
    assert.equal(aiImageFromSrc('data:image/png;base64,AA').name, '图片');
});

test('aiImageFromSrc: 非 data URL 一律返回 null', () => {
    for (const src of [
        '',
        '   ',
        null,
        undefined,
        'https://example.com/a.png',
        'blob:dvfs://abc',
        'D:/data/shot.png',
        'data:image/png',
        'data:;base64,AA',
        'data:image/png;charset=utf8;base64,AA',
    ]) {
        assert.equal(aiImageFromSrc(src, 'x'), null, '应判为不可复制/保存：' + src);
    }
});

test('aiImageFromSrc: 空 base64 载荷返回 null', () => {
    assert.equal(aiImageFromSrc('data:image/png;base64,', 'x'), null);
});

test('aiFindAttachedImageByRef: 来源路径尾段对齐（工作区移动场景）', () => {
    // 会话在旧工作区 D:\Projects\CaDt-DataLens 跑的桌面控制，截图落在旧工作区的
    // .cadt/tmp，read_image 附图后模型在正文里写了相对路径；换到新工作区后正文
    // 引用按当前工作区解析必然不存在——靠附图记录的来源路径尾段找回同一张图。
    const attached = {
        id: 'img-x',
        name: 'family-tree-01.png',
        data: 'AAAA',
        mime: 'image/png',
    };
    const messages = [{
        role: 'user',
        content: '[图片：D:\\Projects\\CaDt-DataLens\\.cadt\\tmp\\family-tree-01.png（read_image 自动附加）]',
        images: [attached],
    }];
    assert.equal(aiFindAttachedImageByRef(messages, '.cadt/tmp/family-tree-01.png'), attached,
        '正文相对路径按尾段对齐附图来源路径');
    assert.equal(aiFindAttachedImageByRef(messages, 'D:/Projects/CaDt-DataLens/.cadt/tmp/family-tree-01.png'), attached,
        '正文绝对路径同样对齐（分隔符与大小写归一）');
    assert.equal(aiFindAttachedImageByRef(messages, 'family-tree-01.png'), attached,
        '裸文件名按 basename 对齐');
});

test('aiFindAttachedImageByRef: 来源尾段匹配压过仅同名候选', () => {
    const sameNameOtherFile = {id: 'img-a', name: 'shot.png', data: 'BBBB', mime: 'image/png'};
    const tailMatch = {id: 'img-b', name: 'shot.png', data: 'CCCC', mime: 'image/png'};
    const messages = [
        {role: 'user', content: '[图片：C:\\其他目录\\shot.png（read_image 自动附加）]', images: [sameNameOtherFile]},
        {role: 'user', content: '[图片：D:\\ws\\.cadt\\tmp\\shot.png（read_image 自动附加）]', images: [tailMatch]},
    ];
    assert.equal(aiFindAttachedImageByRef(messages, '.cadt/tmp/shot.png'), tailMatch);
});

test('aiFindAttachedImageByRef: 同级候选取后出现的（消息按时间序）', () => {
    const older = {id: 'img-1', name: 'a.png', data: 'AAAA', mime: 'image/png'};
    const newer = {id: 'img-2', name: 'a.png', data: 'BBBB', mime: 'image/png'};
    const messages = [
        {role: 'user', content: '第一张', images: [older]},
        {role: 'user', content: '第二张', images: [newer]},
    ];
    assert.equal(aiFindAttachedImageByRef(messages, 'a.png'), newer);
});

test('aiFindAttachedImageByRef: 未水合出 data 的附图不参与兜底', () => {
    // 历史会话从磁盘读回时 data 要靠 hydrateImages 回填，没有 data 就渲染不出来
    const messages = [{
        role: 'user',
        content: '[图片：D:\\x\\family-tree-01.png（read_image 自动附加）]',
        images: [{id: 'img-x', name: 'family-tree-01.png', file: 'images/img-x.png'}],
    }];
    assert.equal(aiFindAttachedImageByRef(messages, 'family-tree-01.png'), null);
});

test('aiFindAttachedImageByRef: 找不到与非法入参一律 null', () => {
    assert.equal(aiFindAttachedImageByRef([], 'a.png'), null);
    assert.equal(aiFindAttachedImageByRef([{role: 'user', content: '无图', images: []}], 'a.png'), null);
    assert.equal(aiFindAttachedImageByRef([{role: 'user', images: [{name: 'a.png', data: 'AA'}]}], 'b.png'), null);
    assert.equal(aiFindAttachedImageByRef([{role: 'user', images: [{name: '', data: 'AA'}]}], 'a.png'), null);
    assert.equal(aiFindAttachedImageByRef(null, 'a.png'), null);
    assert.equal(aiFindAttachedImageByRef([], ''), null);
    assert.equal(aiFindAttachedImageByRef([], null), null);
});

test('aiCtxBannerShow: 达阈值提醒，关闭后按 +5% 档位重新提醒', () => {
    // 阈值内不提醒
    assert.equal(aiCtxBannerShow(0.79, 0.8, null), false);
    assert.equal(aiCtxBannerShow(0.8, 0.8, null), true, '正好踩线即提醒');
    // 未关闭过：达阈值即提醒
    assert.equal(aiCtxBannerShow(0.83, 0.8, null), true);
    // 关闭时 83%：83–87% 不再打扰，88% 起重新提醒（Math.round(87.5)=88，87.4 才取整 87）
    assert.equal(aiCtxBannerShow(0.83, 0.8, 83), false);
    assert.equal(aiCtxBannerShow(0.874, 0.8, 83), false, '87.4% 取整 87，仍在静默档');
    assert.equal(aiCtxBannerShow(0.875, 0.8, 83), true, '87.5% 取整 88，越过静默档');
    assert.equal(aiCtxBannerShow(0.88, 0.8, 83), true);
    // 压缩后回落到阈值下自然隐藏（关闭态不影响显隐判定本身）
    assert.equal(aiCtxBannerShow(0.5, 0.8, 83), false);
    // 非法输入兜底：percent 非数值视为不达阈值
    assert.equal(aiCtxBannerShow(NaN, 0.8, null), false);
    assert.equal(aiCtxBannerShow(undefined, 0.8, null), false);
});

test('aiCtxBannerState: 三档文案与门禁状态', () => {
    // suggest 档（≥压缩阈值、有发送余量）：千分位数字 + 建议压缩
    const suggest = aiCtxBannerState(0.85, 222822, 262144);
    assert.equal(suggest.state, 'suggest');
    assert.equal(suggest.blocked, false);
    assert.equal(suggest.compactBlocked, false);
    assert.equal(suggest.text, '上下文 85%（约 222,822 / 262,144 tokens，估算），建议压缩');
    // over 档（≥发送硬门槛 0.9、未达 100%）：红色门禁态，整体压缩仍可行
    const near = aiCtxBannerState(0.95, 249036, 262144);
    assert.equal(near.state, 'over');
    assert.equal(near.blocked, true);
    assert.equal(near.compactBlocked, false);
    assert.equal(near.text, '上下文 95%（约 249,036 / 262,144 tokens，估算），接近上限，请先压缩再发送');
    // ≥100%：整体压缩请求发不出去（compactBlocked 为 true），但 startCompact 有超窗兜底，
    // 压缩仍可用——文案提示「摘要略粗」而不是禁用按钮/只让切模型
    const beyond = aiCtxBannerState(1.21, 317645, 262144);
    assert.equal(beyond.state, 'over');
    assert.equal(beyond.blocked, true);
    assert.equal(beyond.compactBlocked, true);
    assert.equal(beyond.text, '上下文 121%（约 317,645 / 262,144 tokens，估算），已超过模型上限：可压缩（摘要略粗）或切换更大上下文的模型');
    // 边界：正好 90% 即发送门禁；正好 100% 即压缩门禁
    assert.equal(aiCtxBannerState(0.9, 1000, 1000).blocked, true);
    assert.equal(aiCtxBannerState(0.899, 899, 1000).blocked, false);
    const at = aiCtxBannerState(1, 1000, 1000);
    assert.equal(at.compactBlocked, true);
    assert.equal(at.text.includes('已超过模型上限'), true);
    // windowSize 缺失不判门禁（估算兜底路径）
    const noWindow = aiCtxBannerState(1.5, 1000, 0);
    assert.equal(noWindow.blocked, false);
    assert.equal(noWindow.compactBlocked, false);
});

test('aiFormatDuration: 天/小时/分/秒四档，显示到整数秒，0 值单位跳过', () => {
    // 秒档
    assert.equal(aiFormatDuration(0), '不到 1 秒');
    assert.equal(aiFormatDuration(499), '不到 1 秒');
    assert.equal(aiFormatDuration(500), '1 秒'); // Math.round 进位
    assert.equal(aiFormatDuration(1000), '1 秒');
    assert.equal(aiFormatDuration(59400), '59 秒');
    // 分档
    assert.equal(aiFormatDuration(60000), '1 分');
    assert.equal(aiFormatDuration(90000), '1 分 30 秒');
    assert.equal(aiFormatDuration(3599000), '59 分 59 秒');
    // 小时档（秒要保留）
    assert.equal(aiFormatDuration(3600000), '1 小时');
    assert.equal(aiFormatDuration(3720000), '1 小时 2 分');
    assert.equal(aiFormatDuration(3723000), '1 小时 2 分 3 秒');
    assert.equal(aiFormatDuration(86399000), '23 小时 59 分 59 秒');
    // 天档（秒要保留）
    assert.equal(aiFormatDuration(86400000), '1 天');
    assert.equal(aiFormatDuration(90000000), '1 天 1 小时');
    assert.equal(aiFormatDuration(183600000), '2 天 3 小时');
    assert.equal(aiFormatDuration(183603000), '2 天 3 小时 3 秒');
    // 非法输入兜底
    assert.equal(aiFormatDuration(NaN), '不到 1 秒');
    assert.equal(aiFormatDuration(-1000), '不到 1 秒');
});

test('aiFormatLiveDuration: 不到 1 小时带十分位小数，小时/天档整数秒', () => {
    // 秒档带十分位
    assert.equal(aiFormatLiveDuration(0), '0.0 秒');
    assert.equal(aiFormatLiveDuration(40200), '40.2 秒');
    // 分档带十分位
    assert.equal(aiFormatLiveDuration(220200), '3 分 40.2 秒');
    // 59.96 秒按 0.1s 取整进位到 1 分，不出现非法的「60.0 秒」
    assert.equal(aiFormatLiveDuration(59960), '1 分 0.0 秒');
    // 图片里的 82 分 56.3 秒 → 到小时档，去小数
    assert.equal(aiFormatLiveDuration(4976300), '1 小时 22 分 56 秒');
    // 小时档（整数秒）
    assert.equal(aiFormatLiveDuration(3600000), '1 小时');
    assert.equal(aiFormatLiveDuration(3720000), '1 小时 2 分');
    assert.equal(aiFormatLiveDuration(86399000), '23 小时 59 分 59 秒');
    // 天档（整数秒）
    assert.equal(aiFormatLiveDuration(86400000), '1 天');
    assert.equal(aiFormatLiveDuration(183603000), '2 天 3 小时 3 秒');
    // 非法输入兜底
    assert.equal(aiFormatLiveDuration(NaN), '0.0 秒');
    assert.equal(aiFormatLiveDuration(-1000), '0.0 秒');
});

test('aiMsgActionsStepMode: 三档颗粒度只作用于中间步骤，最后一条恒完整', () => {
    // 最后一条消息任何档位都是完整操作行
    assert.equal(aiMsgActionsStepMode('full', true), 'full');
    assert.equal(aiMsgActionsStepMode('mid-basic', true), 'full');
    assert.equal(aiMsgActionsStepMode('last-only', true), 'full');
    // 中间步骤：full 完整 / mid-basic 只留复制+回退 / last-only 整行不出现
    assert.equal(aiMsgActionsStepMode('full', false), 'full');
    assert.equal(aiMsgActionsStepMode('mid-basic', false), 'basic');
    assert.equal(aiMsgActionsStepMode('last-only', false), 'none');
    // 非法档位回落 full
    assert.equal(aiMsgActionsStepMode('bogus', false), 'full');
    assert.equal(aiMsgActionsStepMode(undefined, false), 'full');
});

test('aiIsContextOverflowError: 只认超窗措辞，不误伤鉴权/限流错误', () => {
    // 各协议服务商的真实措辞
    assert.equal(aiIsContextOverflowError('This model\'s maximum context length is 128000 tokens'), true);
    assert.equal(aiIsContextOverflowError('context_length_exceeded'), true);
    assert.equal(aiIsContextOverflowError('Prompt is too long: 210000 tokens'), true);
    assert.equal(aiIsContextOverflowError('Input is too long for requested model'), true);
    assert.equal(aiIsContextOverflowError('上下文长度超过模型上限'), true);
    assert.equal(aiIsContextOverflowError('请求的上下文窗口已满'), true);
    // 非超窗错误不能被误判成「该压缩」
    assert.equal(aiIsContextOverflowError('HTTP 401: invalid api key'), false);
    assert.equal(aiIsContextOverflowError('429 rate limit exceeded'), false);
    assert.equal(aiIsContextOverflowError('invalid request: messages[2].role'), false);
    assert.equal(aiIsContextOverflowError(''), false);
    assert.equal(aiIsContextOverflowError(null), false);
});

// 应用重启时挂起的卡片：卡片降级为终态，但这条工具结果仍会发给模型。
// 核心不变量——正文不能留「等待…」口吻（模型会当成已有结果），必须说清没收到 / 没执行。
test('重启遗留卡片的工具结果文案：说清「没收到」，且不留占位口吻', () => {
    const cases = [
        ['ASK_LOST_TEXT', ASK_LOST_TEXT],
        ['APPROVAL_LOST_TEXT', APPROVAL_LOST_TEXT],
        ['ENV_ASK_LOST_TEXT', ENV_ASK_LOST_TEXT],
    ];
    const placeholders = ['等待用户回答…', '等待用户审批…', '等待用户审批命令…', '等待 AI 分类器判定…', '等待用户填写变量值…'];
    for (const [name, text] of cases) {
        assert.equal(typeof text, 'string', name + ' 必须是字符串');
        assert.ok(text.length > 20, name + ' 太短，缺少可判断的信息');
        // 不能是注册时那句进行时占位（模型会读成「还在等」），但允许「在等待…时关闭了」这种叙述
        assert.ok(!placeholders.includes(text), name + ' 不能沿用注册时的占位正文');
        assert.ok(!text.endsWith('…'), name + ' 不能以省略号收尾，读起来像还没结束');
        assert.ok(/没收到/.test(text), name + ' 必须明确「没收到」');
    }
    // 语义分工：ask 是答案未知（可以重问），审批 / 变量是没执行（需要就重提）
    assert.ok(/答案未知/.test(ASK_LOST_TEXT) && /ask_user/.test(ASK_LOST_TEXT), 'ask 遗失文案要给「答案未知 + 可重问」的出路');
    assert.ok(/没有执行/.test(APPROVAL_LOST_TEXT), '审批遗失必须说清副作用未发生');
    assert.ok(/没有创建/.test(ENV_ASK_LOST_TEXT), '变量创建遗失必须说清未创建');
    // 与「工具执行中被中断」区分开：那个是副作用未知，这里是决定 / 回答未知
    assert.notEqual(ASK_LOST_TEXT, TOOL_INTERRUPTED_TEXT);
    assert.notEqual(APPROVAL_LOST_TEXT, TOOL_INTERRUPTED_TEXT);
    assert.notEqual(ASK_LOST_TEXT, APPROVAL_LOST_TEXT);
    assert.notEqual(APPROVAL_LOST_TEXT, ENV_ASK_LOST_TEXT);
});

test('aiFormatBytes: B/KB/MB/GB/TB 进制，≥100 档取整，非法值按 0', () => {
    assert.equal(aiFormatBytes(0), '0 B');
    assert.equal(aiFormatBytes(undefined), '0 B');
    assert.equal(aiFormatBytes(-5), '0 B');
    assert.equal(aiFormatBytes(9616029), '9.2 MB');
    assert.equal(aiFormatBytes(1023), '1023 B');
    assert.equal(aiFormatBytes(1024), '1.0 KB');
    assert.equal(aiFormatBytes(40056 * 1024), '39.1 MB');
    assert.equal(aiFormatBytes(100 * 1024 * 1024), '100 MB');
    assert.equal(aiFormatBytes(1.1 * 1024 * 1024 * 1024), '1.1 GB');
    assert.equal(aiFormatBytes(2048 * 1024 * 1024 * 1024), '2.0 TB');
});
