// ai-gen-settings.js：设置 → AI → 生图与视频模型 pane（条目列表 + 编辑器弹窗 + 测试连接）。
// 编辑器用居中动态弹窗（openAIDialog 三件套，仿计时器创建对话框），表单控件一律走
// core/form-controls.js 工厂（表单控件硬规范：禁止裸原生控件）。条目数据层在 ai-gen-model.js。
//
// 列表按类型分成「生图 / 视频」两组渲染，组内顺序即优先级顺序（ai-gen-model 的
// defaultGenModelOf 取同类型第一个启用的条目）——数据仍是同一个 genModels[]，
// 上移/下移只在同类型的槽位之间交换（moveGenModelWithinKind），不会打乱另一组。
import {iconSvg} from '../../core/icons.js';
import {createInput, createSelect, createSwitch, createTextarea} from '../../core/form-controls.js';
import {aiNowId} from '../core/ai-constants.js';
import {parseJson} from '../../core/json-safe.js';
import {
    buildGenConfigExport,
    buildGenVars,
    extractGenPath,
    GEN_KINDS,
    GEN_KIND_LABELS,
    GEN_MODEL_PRESETS,
    genHeaderMap,
    genJoinURL,
    isAsyncGenModel,
    mergeGenConfigImport,
    moveGenModelWithinKind,
    normalizeGenModel,
    parseGenConfigImport,
    renderGenJson,
} from './ai-gen-model.js';

export function createAIGenSettings(ctx, extras) {

    const getConfig = ctx.getConfig;
    const saveAIConfig = ctx.saveAIConfig;
    const backend = ctx.backend;
    const askConfirm = ctx.askConfirm;
    const setSettingsStatus = extras.setSettingsStatus;
    const listEl = document.getElementById('ai-gen-list');
    const presetSelect = document.getElementById('ai-gen-preset');

    // 编辑器状态：editingId = null 表示新建；无临时插入 config 的中间态（保存才落）。
    let genEditorState = null;  // {editingId, entry}
    let genEditorControls = null; // 弹窗打开期间的控件表（collectDraft 读取）

    function entries() {
        return getConfig().genModels || [];
    }

    // ---------- 列表 ----------

    // 按类型分组的渲染顺序固定为 GEN_KINDS（生图在前、视频在后），与数据里的穿插顺序无关。
    function kindGroupOf(list, kind) {
        return list.filter((entry) => entry && entry.kind === kind);
    }

    function renderGenList() {
        if (!listEl) return;
        listEl.innerHTML = '';
        const list = entries();
        if (!list.length) {
            const empty = document.createElement('div');
            empty.className = 'set-card';
            const row = document.createElement('div');
            row.className = 'set-row';
            const main = document.createElement('div');
            main.className = 'set-main';
            const title = document.createElement('div');
            title.className = 'set-title';
            title.textContent = '还没有生成条目';
            const desc = document.createElement('div');
            desc.className = 'set-desc';
            desc.textContent = '用上方「添加预设」快速接入 OpenAI 兼容生图接口，或「新建条目」自定义模板。';
            main.append(title, desc);
            row.appendChild(main);
            empty.appendChild(row);
            listEl.appendChild(empty);
            return;
        }
        for (const kind of GEN_KINDS) {
            const group = kindGroupOf(list, kind);
            listEl.appendChild(buildKindHead(kind, group.length));
            if (!group.length) {
                listEl.appendChild(buildKindEmpty(kind));
                continue;
            }
            for (const entry of group) listEl.appendChild(buildRow(entry, group));
        }
    }

    // 组头只报类型与条数：优先级这件事由条目的 #n / 缺省徽标与上移下移按钮的提示自己说明，
    // 每组再挂一句重复的说明只是噪声（顶部说明已经交代过「组内顺序即优先级」）。
    function buildKindHead(kind, count) {
        const head = document.createElement('div');
        head.className = 'set-group-title';
        head.textContent = (GEN_KIND_LABELS[kind] || kind) + (count ? ' · ' + count + ' 条' : '');
        return head;
    }

    function buildKindEmpty(kind) {
        const card = document.createElement('div');
        card.className = 'set-card';
        const row = document.createElement('div');
        row.className = 'set-row';
        const main = document.createElement('div');
        main.className = 'set-main';
        const desc = document.createElement('div');
        desc.className = 'set-desc';
        desc.textContent = kind === 'video'
            ? '还没有视频条目：generate_video 需要一条启用且配了提交/轮询端点的条目。'
            : '还没有生图条目：generate_image 需要一条启用的条目。';
        main.appendChild(desc);
        row.appendChild(main);
        card.appendChild(row);
        return card;
    }

    // 组内上移 / 下移：只改同类型的槽位顺序，另一组的相对顺序与所有条目的绝对位置都不受影响。
    function moveEntry(entry, delta) {
        const list = getConfig().genModels || [];
        const next = moveGenModelWithinKind(list, entry.id, delta);
        if (next === list) return;
        getConfig().genModels = next;
        saveAIConfig();
        renderGenList();
    }

    function moveButton(label, icon, disabled, onClick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dlg-btn gen-move';
        btn.dataset.tip = label;
        btn.setAttribute('aria-label', label);
        btn.innerHTML = iconSvg(icon, 12);
        btn.disabled = !!disabled;
        if (!disabled) btn.addEventListener('click', onClick);
        return btn;
    }

    function buildRow(entry, group) {
        const pos = group.indexOf(entry);
        const enabledEntries = group.filter((item) => item.enabled !== false);
        const isDefault = entry.enabled !== false && enabledEntries[0] === entry;

        const card = document.createElement('div');
        card.className = 'set-card';
        const row = document.createElement('div');
        row.className = 'set-row';
        const main = document.createElement('div');
        main.className = 'set-main';
        const title = document.createElement('div');
        title.className = 'set-title';
        title.textContent = (entry.name || '（未命名条目）') + ' · ' + (GEN_KIND_LABELS[entry.kind] || entry.kind);
        if (entry.enabled === false) title.textContent += '（停用）';
        const badge = document.createElement('span');
        badge.className = 'gen-prio' + (isDefault ? ' is-default' : '');
        badge.textContent = '#' + (pos + 1) + (isDefault ? ' 缺省' : '');
        title.appendChild(badge);
        const desc = document.createElement('div');
        desc.className = 'set-desc';
        const target = isAsyncGenModel(entry) ? '异步：' + entry.submitPath + ' → ' + entry.pollPath : (entry.path || '未配置路径');
        desc.textContent = (entry.baseURL || '') + (entry.baseURL && target ? '  ·  ' : '') + target +
            (entry.editPath ? '  ·  图生图 ' + entry.editPath : '');
        main.append(title, desc);
        const control = document.createElement('div');
        control.className = 'set-control';
        control.append(
            moveButton('上移一位（提高优先级）', 'chevron-up', pos <= 0, () => moveEntry(entry, -1)),
            moveButton('下移一位（降低优先级）', 'chevron-down', pos >= group.length - 1, () => moveEntry(entry, 1)),
        );
        const enabledSwitch = createSwitch({
            checked: entry.enabled !== false,
            title: '启用 / 停用（停用的条目不参与缺省解析，AI 工具不再选中它）',
            onChange: () => {
                entry.enabled = enabledSwitch.control.checked;
                saveAIConfig();
                renderGenList();
            },
        });
        control.appendChild(enabledSwitch.element);
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'dlg-btn';
        editBtn.textContent = '编辑';
        editBtn.addEventListener('click', () => openGenEditor(entry.id));
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'dlg-btn';
        copyBtn.textContent = '复制';
        copyBtn.addEventListener('click', () => {
            const clone = normalizeGenModel({...entry, id: '', name: (entry.name || '条目') + ' 副本'}, () => aiNowId('gen-'));
            // 副本紧跟在原件之后：复制出来的条目优先级就在原件下一位，不必再手动上移
            const list = entries();
            const index = list.findIndex((item) => item.id === entry.id);
            const next = list.slice();
            next.splice(index < 0 ? next.length : index + 1, 0, clone);
            getConfig().genModels = next;
            saveAIConfig();
            renderGenList();
            setSettingsStatus('已复制生成条目：' + clone.name, 'ok');
        });
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'dlg-btn';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', () => {
            askConfirm('删除生成条目「' + (entry.name || entry.id) + '」？', () => {
                getConfig().genModels = entries().filter((item) => item.id !== entry.id);
                saveAIConfig();
                renderGenList();
                setSettingsStatus('已删除生成条目', 'ok');
            }, '删除', '删除条目');
        });
        control.append(editBtn, copyBtn, delBtn);
        row.append(main, control);
        card.appendChild(row);
        return card;
    }

    // ---------- 编辑器弹窗 ----------

    function fieldRow(title, desc, ...controlEls) {
        const row = document.createElement('div');
        row.className = 'set-row';
        const main = document.createElement('div');
        main.className = 'set-main';
        const t = document.createElement('div');
        t.className = 'set-title';
        t.textContent = title;
        main.appendChild(t);
        if (desc) {
            const d = document.createElement('div');
            d.className = 'set-desc';
            d.textContent = desc;
            main.appendChild(d);
        }
        const box = document.createElement('div');
        box.className = 'set-control';
        for (const el of controlEls) {
            if (el) box.appendChild(el);
        }
        row.append(main, box);
        return row;
    }

    // 多行输入独占一行：塞进 .set-control 会被 210px 定宽压成一条窄缝（还和标题挤在同一行），
    // 请求头 / 请求体模板这种要逐行读的内容根本看不清。沿用设置页「标题一行 + 控件整行」的
    // .set-row-top 结构（style.css 里 `.set-row-top > textarea` 负责撑满宽度）。
    function fieldStack(title, desc, controlEl) {
        const row = document.createElement('div');
        row.className = 'set-row-top';
        const main = document.createElement('div');
        main.className = 'set-main';
        const t = document.createElement('div');
        t.className = 'set-title';
        t.textContent = title;
        main.appendChild(t);
        if (desc) {
            const d = document.createElement('div');
            d.className = 'set-desc gen-desc-preline';
            d.textContent = desc;
            main.appendChild(d);
        }
        row.appendChild(main);
        if (controlEl) row.appendChild(controlEl);
        return row;
    }

    function groupTitle(text) {
        const title = document.createElement('div');
        title.className = 'set-group-title';
        title.textContent = text;
        return title;
    }

    function openGenEditor(entryId, presetEntry) {
        const list = entries();
        const current = entryId ? list.find((item) => item.id === entryId) : null;
        const base = current ? {...current} : normalizeGenModel({...((presetEntry && presetEntry.entry) || {}), id: '', enabled: true}, () => aiNowId('gen-'));
        genEditorState = {editingId: current ? current.id : null, entry: current ? {...current} : null};

        const nameCtl = createInput({value: base.name, placeholder: '如 SiliconFlow Kolors', spellcheck: false});
        const kindCtl = createSelect({
            options: GEN_KINDS.map((kind) => ({value: kind, label: GEN_KIND_LABELS[kind] + '（' + (kind === 'image' ? 'image' : 'video') + '）'})),
            value: base.kind,
        });
        const enabledCtl = createSwitch({checked: base.enabled !== false});
        const keyCtl = createInput({value: base.apiKey, placeholder: '只保存在本机 ai-config.json，随请求头发出，不写日志', spellcheck: false, autocomplete: 'off'});
        const proxyCtl = createSelect({
            options: [{value: 'system', label: '系统代理'}, {value: 'direct', label: '直连'}, {value: 'custom', label: '自定义代理…'}],
            value: base.proxy === 'direct' ? 'direct' : (isProxyURL(base.proxy) ? 'custom' : 'system'),
        });
        const proxyURLCtl = createInput({value: isProxyURL(base.proxy) ? base.proxy : '', placeholder: 'http://127.0.0.1:7890 或 socks5://…', spellcheck: false});
        proxyURLCtl.element.style.display = proxyCtl.control.value === 'custom' ? '' : 'none';
        proxyCtl.control.addEventListener('change', () => {
            proxyURLCtl.element.style.display = proxyCtl.control.value === 'custom' ? '' : 'none';
        });
        const timeoutCtl = createInput({type: 'number', value: base.timeoutSec, min: 30, max: 300, step: 10});
        const baseURLCtl = createInput({value: base.baseURL, placeholder: 'https://api.siliconflow.cn 或 http://127.0.0.1:8188（本地服务）', spellcheck: false});
        const pathCtl = createInput({value: base.path, placeholder: '/v1/images/generations', spellcheck: false});
        const editPathCtl = createInput({value: base.editPath, placeholder: '/v1/images/edits（留空 = 不支持参考图）', spellcheck: false});
        const editWrapCtl = createInput({value: base.editImageWrap, placeholder: 'image_url（留空 = 裸字符串数组）', spellcheck: false});
        const editFormatCtl = createSelect({
            options: [
                {value: 'json', label: 'JSON（模板即请求体）'},
                {value: 'multipart', label: 'multipart（图片走文件字段）'},
            ],
            value: base.editFormat === 'multipart' ? 'multipart' : 'json',
        });
        const headersCtl = createTextarea({
            value: headersToText(base.headers), rows: 4, spellcheck: false,
            placeholder: '每行一条：Key: Value\nAuthorization: Bearer {{apiKey}}',
        });
        const bodyCtl = createTextarea({
            value: base.bodyTemplate, rows: 8, spellcheck: false,
            placeholder: '{"prompt":{{prompt}},"size":{{size}}}',
        });
        const resultTypeCtl = createSelect({
            options: [{value: 'b64', label: 'b64（响应内嵌 base64）'}, {value: 'url', label: 'url（响应给下载地址）'}],
            value: base.resultType,
        });
        const resultPathCtl = createInput({value: base.resultPath, placeholder: 'data[*].b64_json', spellcheck: false});
        const errorPathCtl = createInput({value: base.errorPath, placeholder: 'error.message', spellcheck: false});
        const defaultModelCtl = createInput({value: base.defaultModel, placeholder: 'Kwai-Kolors/Kolors', spellcheck: false});
        const defaultSizeCtl = createInput({value: base.defaultSize, placeholder: '1024x1024', spellcheck: false});
        const defaultNCtl = createInput({type: 'number', value: base.defaultN, min: 1, max: 4, step: 1});
        const submitPathCtl = createInput({value: base.submitPath, placeholder: '/v1/video/submit（留空 = 同步型条目）', spellcheck: false});
        const jobIdPathCtl = createInput({value: base.jobIdPath, placeholder: 'output.task_id', spellcheck: false});
        const pollPathCtl = createInput({value: base.pollPath, placeholder: '/v1/video/status?task_id={{jobId}}', spellcheck: false});
        const statusPathCtl = createInput({value: base.statusPath, placeholder: 'output.task_status', spellcheck: false});
        const probePathCtl = createInput({value: base.probePath, placeholder: '/v1/videos/{{jobId}}/content（可选）', spellcheck: false});
        const doneValueCtl = createInput({value: base.doneValue, placeholder: 'SUCCESS', spellcheck: false});
        const failedValueCtl = createInput({value: base.failedValue, placeholder: 'FAIL', spellcheck: false});
        const pollIntervalCtl = createInput({type: 'number', value: base.pollIntervalSec, min: 2, max: 30, step: 1});
        const maxPollsCtl = createInput({type: 'number', value: base.maxPolls, min: 1, max: 240, step: 1});

        const body = document.createElement('div');
        body.appendChild(groupTitle('基本信息'));
        body.appendChild(fieldRow('名称', '', nameCtl.element));
        body.appendChild(fieldRow('类型', '决定 generate_image 还是 generate_video 使用它，以及产物落盘目录', kindCtl.element, enabledCtl.element));
        body.appendChild(fieldRow('API Key', '', keyCtl.element));
        body.appendChild(fieldRow('代理', 'system 跟随系统；本地服务一般直连', proxyCtl.element, proxyURLCtl.element));
        body.appendChild(fieldRow('单次请求超时（秒）', '', timeoutCtl.element));
        body.appendChild(groupTitle('请求'));
        body.appendChild(fieldRow('服务地址 baseURL', '同步型/异步型共用的服务根地址', baseURLCtl.element));
        body.appendChild(fieldRow('生成端点 path', '同步型：直接生成接口；异步型：留空（走下方提交端点）', pathCtl.element));
        body.appendChild(fieldRow('编辑端点 editPath',
            '图生图 / 图像编辑（同步型）：带参考图时用它替代上面两个端点；留空 = 不支持参考图',
            editPathCtl.element));
        body.appendChild(fieldRow('编辑端点格式',
            'JSON：参考图经 {{images}} 进请求体模板；multipart：参考图作为 image 文件字段重复提交、模板只提供其余文本字段（Qwen-Image / OpenAI 官方 /v1/images/edits 这类接口，且只接受本地图片）',
            editFormatCtl.element));
        body.appendChild(fieldRow('参考图包装字段', 'JSON 格式：参考图数组元素的字段名，如 image_url（SenseNova / 豆包 / 万相同构）；留空 = 裸字符串数组。multipart 格式：文件字段名（留空 = image）', editWrapCtl.element));
        body.appendChild(fieldStack('自定义请求头', '每行一条「Key: Value」；{{apiKey}} 会替换为上方密钥', headersCtl.element));
        body.appendChild(fieldStack('请求体模板',
            '占位符渲染为 JSON 字面量（字符串自动带引号转义），模板里不要手写引号：\n{"prompt":{{prompt}}} 是对的，"prompt":"{{prompt}}" 是错的\n' +
            '图生图用 {{images}}（已渲染成数组，同样不要再包引号）：{"model":{{model}},"images":{{images}},"prompt":{{prompt}}}',
            bodyCtl.element));
        body.appendChild(groupTitle('响应'));
        body.appendChild(fieldRow('产物形态', '', resultTypeCtl.element));
        body.appendChild(fieldRow('产物提取路径', '如 data[*].b64_json（[*] 取多张）；空路径取整个响应', resultPathCtl.element));
        body.appendChild(fieldRow('错误提取路径', '服务端错误文案的位置，失败时回给 AI 自修', errorPathCtl.element));
        body.appendChild(fieldRow('默认模型', '工具未传 model 时使用', defaultModelCtl.element));
        body.appendChild(fieldRow('默认尺寸', '工具未传 size 时使用', defaultSizeCtl.element));
        body.appendChild(fieldRow('默认张数', '1-4（仅生图）', defaultNCtl.element));
        body.appendChild(groupTitle('异步任务（视频 / 任务型接口必填；留空提交路径即同步型）'));
        body.appendChild(fieldRow('提交端点', '', submitPathCtl.element));
        body.appendChild(fieldRow('任务 ID 提取路径', '从提交响应里取任务 id', jobIdPathCtl.element));
        body.appendChild(fieldRow('轮询端点', '支持 {{jobId}} 占位', pollPathCtl.element));
        body.appendChild(fieldRow('状态字段路径 / 完成值 / 失败值', '如 output.task_status · SUCCESS · FAIL', statusPathCtl.element, doneValueCtl.element, failedValueCtl.element));
        body.appendChild(fieldRow('探针端点（可选）',
            '有的服务端任务跑完后，响应里不含可下载地址（url 为空、只给本机文件路径），产物要从独立端点取。填这个端点后，轮询时会额外探一次，**2xx 即视为完成**、产物直接用它下载（带下方请求头，下载端点通常要鉴权）。支持 {{jobId}}，形如 /v1/videos/{{jobId}}/content',
            probePathCtl.element));
        body.appendChild(fieldRow('轮询间隔（秒）', '2-30', pollIntervalCtl.element));
        body.appendChild(fieldRow('最大轮询次数', '超限判失败', maxPollsCtl.element));

        const statusLine = document.createElement('div');
        statusLine.className = 'set-desc';
        statusLine.style.minHeight = '14px';

        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'dlg-btn';
        testBtn.textContent = '测试连接';
        testBtn.addEventListener('click', () => {
            testGenConnection(collectDraft(), statusLine, testBtn);
        });

        const cancelBtn = ctx.dialogButton('取消', 'dlg-btn', () => {
            genEditorControls = null;
            ctx.closeAIDialog();
        });
        const saveBtn = ctx.dialogButton('保存', 'dlg-btn primary', () => {
            saveGenEditor(collectDraft(), statusLine);
        });

        genEditorControls = {
            name: nameCtl, kind: kindCtl, enabled: enabledCtl, apiKey: keyCtl,
            proxy: proxyCtl, proxyURL: proxyURLCtl, timeout: timeoutCtl,
            baseURL: baseURLCtl, path: pathCtl, editPath: editPathCtl, editImageWrap: editWrapCtl, editFormat: editFormatCtl,
            headers: headersCtl, body: bodyCtl,
            resultType: resultTypeCtl, resultPath: resultPathCtl, errorPath: errorPathCtl,
            defaultModel: defaultModelCtl, defaultSize: defaultSizeCtl, defaultN: defaultNCtl,
            submitPath: submitPathCtl, jobIdPath: jobIdPathCtl, pollPath: pollPathCtl,
            statusPath: statusPathCtl, doneValue: doneValueCtl, failedValue: failedValueCtl,
            pollInterval: pollIntervalCtl, maxPolls: maxPollsCtl, probePath: probePathCtl,
        };
        ctx.openAIDialog((genEditorState.editingId ? '编辑生成条目' : '新建生成条目') +
            (genEditorState.entry && genEditorState.entry.name ? ' · ' + genEditorState.entry.name : ''),
            [body], [testBtn, statusLine, cancelBtn, saveBtn], {top: true, wide: true});
        // 弹窗里的三个下拉同样走设置页的行式下拉（enhanceSelect）：原生 select 会露出系统下拉，
        // 跟自绘触发器混在一起像两套控件。必须在 openAIDialog 之后增强——wrap 要插进已入 DOM 的节点。
        if (typeof ctx.enhanceSelect === 'function') {
            for (const ctl of [kindCtl, proxyCtl, resultTypeCtl, editFormatCtl]) ctx.enhanceSelect(ctl.control);
        }
    }

    function isProxyURL(value) {
        return /^(https?|socks5):\/\//i.test(String(value || ''));
    }

    function headersToText(headers) {
        return (headers || []).map((item) => item.key + ': ' + item.value).join('\n');
    }

    function collectDraft() {
        const c = genEditorControls;
        if (!c) throw new Error('编辑器未初始化');
        return {
            name: c.name.control.value,
            kind: c.kind.control.value,
            enabled: c.enabled.control.checked,
            baseURL: c.baseURL.control.value,
            path: c.path.control.value,
            editPath: c.editPath.control.value,
            editImageWrap: c.editImageWrap.control.value,
            editFormat: c.editFormat.control.value,
            proxy: c.proxy.control.value,
            proxyURL: c.proxyURL.control.value,
            timeoutSec: Number(c.timeout.control.value) || 120,
            apiKey: c.apiKey.control.value,
            headers: c.headers.control.value,
            bodyTemplate: c.body.control.value,
            resultType: c.resultType.control.value,
            resultPath: c.resultPath.control.value,
            errorPath: c.errorPath.control.value,
            defaultModel: c.defaultModel.control.value,
            defaultSize: c.defaultSize.control.value,
            defaultN: Number(c.defaultN.control.value) || 1,
            submitPath: c.submitPath.control.value,
            jobIdPath: c.jobIdPath.control.value,
            pollPath: c.pollPath.control.value,
            statusPath: c.statusPath.control.value,
            probePath: c.probePath.control.value,
            doneValue: c.doneValue.control.value,
            failedValue: c.failedValue.control.value,
            pollIntervalSec: Number(c.pollInterval.control.value) || 5,
            maxPolls: Number(c.maxPolls.control.value) || 60,
        };
    }

    function saveGenEditor(draft, statusLine) {
        try {
            const entry = normalizeGenModel({
                id: genEditorState.editingId || '',
                name: draft.name,
                kind: draft.kind,
                enabled: draft.enabled,
                baseURL: draft.baseURL,
                path: draft.path,
                editPath: draft.editPath,
                editImageWrap: draft.editImageWrap,
                editFormat: draft.editFormat,
                proxy: draft.proxy === 'custom' ? (draft.proxyURL || 'system') : draft.proxy,
                timeoutSec: draft.timeoutSec,
                apiKey: draft.apiKey,
                headers: draft.headers,
                bodyTemplate: draft.bodyTemplate,
                resultType: draft.resultType,
                resultPath: draft.resultPath,
                errorPath: draft.errorPath,
                defaultModel: draft.defaultModel,
                defaultSize: draft.defaultSize,
                defaultN: draft.defaultN,
                submitPath: draft.submitPath,
                jobIdPath: draft.jobIdPath,
                pollPath: draft.pollPath,
                statusPath: draft.statusPath,
                probePath: draft.probePath,
                doneValue: draft.doneValue,
                failedValue: draft.failedValue,
                pollIntervalSec: draft.pollIntervalSec,
                maxPolls: draft.maxPolls,
            }, () => aiNowId('gen-'));
            if (!entry.name) throw new Error('条目名称为空');
            if (!entry.baseURL) throw new Error('服务地址（baseURL）为空');
            const list = entries();
            const index = genEditorState.editingId ? list.findIndex((item) => item.id === genEditorState.editingId) : -1;
            if (index >= 0) list[index] = entry;
            else list.push(entry);
            getConfig().genModels = list;
            saveAIConfig();
            renderGenList();
            ctx.closeAIDialog();
            setSettingsStatus('已保存生成条目：' + (entry.name || entry.id), 'ok');
        } catch (e) {
            statusLine.textContent = '保存失败：' + ((e && e.message) || e);
        }
    }

    async function testGenConnection(draft, statusLine, testBtn) {
        statusLine.textContent = '测试中…';
        testBtn.disabled = true;
        try {
            const entry = normalizeGenModel({
                ...draft,
                proxy: draft.proxy === 'custom' ? (draft.proxyURL || 'system') : draft.proxy,
            }, () => aiNowId('gen-'));
            if (!entry.baseURL) throw new Error('服务地址为空');
            const useAsync = isAsyncGenModel(entry);
            const url = genJoinURL(entry.baseURL, useAsync ? entry.submitPath : entry.path);
            if (!url) throw new Error(useAsync ? '提交端点为空' : '生成端点为空');
            const vars = buildGenVars(entry, {prompt: 'a small red circle on a white background'});
            const resp = await backend.AIGenHTTPRequest(JSON.stringify({
                url,
                method: 'POST',
                headers: genHeaderMap(entry, vars),
                body: renderGenJson(entry.bodyTemplate, vars),
                proxy: entry.proxy,
                timeoutSec: entry.timeoutSec,
                maxBytes: 8 << 20,
            }));
            if (resp && resp.error) throw new Error(resp.error);
            const parsed = parseJson(resp && resp.body, null);
            if (parsed && entry.errorPath) {
                const errors = extractGenPath(parsed, entry.errorPath);
                if (errors.length && String(errors[0]).trim()) throw new Error('服务端返回错误：' + String(errors[0]).trim());
            }
            if (resp && resp.status >= 400) throw new Error('HTTP ' + resp.status + '：' + String(resp.body || '').slice(0, 200));
            let hit = 0;
            if (parsed && entry.resultPath) hit = extractGenPath(parsed, entry.resultPath).length;
            statusLine.textContent = hit > 0
                ? '测试通过：HTTP ' + resp.status + '，提取到 ' + hit + ' 个产物' + (useAsync ? '（任务型接口请再跑一次真实生成验证轮询）' : '')
                : 'HTTP ' + resp.status + '，但产物提取路径未命中' + (useAsync ? '（任务型接口提交成功，轮询段请用真实生成验证）' : '——请检查 resultPath');
        } catch (e) {
            statusLine.textContent = '测试失败：' + ((e && e.message) || e);
        } finally {
            testBtn.disabled = false;
        }
    }

    // ---------- 导入 / 导出配置 ----------

    async function exportGenConfig() {
        const includeKeys = !!(document.getElementById('ai-gen-export-keys') &&
            document.getElementById('ai-gen-export-keys').checked);
        const json = JSON.stringify(buildGenConfigExport(entries(), {includeKeys}), null, 2);
        try {
            let path = '';
            if (backend.ShowSaveFileDialog) {
                path = await backend.ShowSaveFileDialog('导出生成条目配置', 'cadt-gen-models.json', '*.json');
            } else if (backend.SaveFileDialog) {
                path = await backend.SaveFileDialog('cadt-gen-models.json');
            } else {
                throw new Error('当前版本不支持保存对话框');
            }
            if (!path) {
                setSettingsStatus('已取消导出', 'ok');
                return;
            }
            await backend.SaveFile(path, json, 'lf', false, 'utf-8');
            setSettingsStatus('生成条目配置已导出：' + path + (includeKeys ? '（含密钥，请妥善保管）' : '（不含密钥）'), 'ok');
        } catch (e) {
            setSettingsStatus('导出失败：' + ((e && e.message) || e), 'error');
        }
    }

    async function importGenConfig() {
        if (!backend.ShowOpenFileDialog) {
            setSettingsStatus('当前版本不支持导入对话框', 'error');
            return;
        }
        let path = '';
        try {
            path = await backend.ShowOpenFileDialog('导入生成条目配置', '*.json');
        } catch (e) {
            setSettingsStatus('导入失败：' + ((e && e.message) || e), 'error');
            return;
        }
        if (!path) {
            setSettingsStatus('已取消导入', 'ok');
            return;
        }
        let read;
        try {
            read = await ctx.readTextFile(path, 4 << 20);
        } catch (e) {
            setSettingsStatus('导入失败：读取文件出错——' + ((e && e.message) || e), 'error');
            return;
        }
        let incoming;
        try {
            incoming = parseGenConfigImport(read.text, () => aiNowId('gen-'));
        } catch (e) {
            setSettingsStatus('导入失败：' + ((e && e.message) || e), 'error');
            return;
        }
        const replaceMode = !!(document.getElementById('ai-gen-import-replace') &&
            document.getElementById('ai-gen-import-replace').checked);
        const confirmLabel = replaceMode
            ? '导入 ' + incoming.length + ' 条生成条目，并替换当前全部条目？当前条目将被清除，此操作不可撤销。'
            : '导入 ' + incoming.length + ' 条生成条目？同 id 条目将被覆盖，其余条目保留。';
        askConfirm(confirmLabel, () => {
            const result = mergeGenConfigImport(entries(), incoming, {
                mode: replaceMode ? 'replace' : 'merge',
                idGen: () => aiNowId('gen-'),
            });
            getConfig().genModels = result.list;
            saveAIConfig();
            renderGenList();
            if (replaceMode) {
                setSettingsStatus('已导入并替换：' + result.list.length + ' 条生成条目', 'ok');
            } else {
                setSettingsStatus('已导入生成条目：新增 ' + result.added + ' 条，更新 ' + result.updated + ' 条', 'ok');
            }
        });
    }

    // ---------- 预设与新建 ----------

    function renderGenPresetSelect() {
        if (!presetSelect) return;
        presetSelect.innerHTML = '';
        for (const preset of GEN_MODEL_PRESETS) {
            const item = document.createElement('option');
            item.value = preset.key;
            item.textContent = preset.name;
            presetSelect.appendChild(item);
        }
    }

    function bindGenPane() {
        const createBtn = document.getElementById('ai-gen-create');
        const presetAdd = document.getElementById('ai-gen-preset-add');
        const exportBtn = document.getElementById('ai-gen-export');
        const importBtn = document.getElementById('ai-gen-import');
        if (createBtn && !createBtn.dataset.bound) {
            createBtn.dataset.bound = '1';
            createBtn.addEventListener('click', () => openGenEditor(null, null));
        }
        if (presetAdd && !presetAdd.dataset.bound) {
            presetAdd.dataset.bound = '1';
            presetAdd.addEventListener('click', () => {
                const preset = GEN_MODEL_PRESETS.find((item) => item.key === (presetSelect && presetSelect.value)) || GEN_MODEL_PRESETS[0];
                openGenEditor(null, preset);
            });
        }
        if (exportBtn && !exportBtn.dataset.bound) {
            exportBtn.dataset.bound = '1';
            exportBtn.addEventListener('click', () => exportGenConfig());
        }
        if (importBtn && !importBtn.dataset.bound) {
            importBtn.dataset.bound = '1';
            importBtn.addEventListener('click', () => importGenConfig());
        }
        renderGenPresetSelect();
        renderGenList();
    }

    return {
        renderGenList,
        bindGenPane,
        openGenEditor,
    };
}
