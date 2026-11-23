// ai-tool-schedule.js：一轮内多个工具调用的执行批次划分（纯函数）。
//
// 背景：四家参考 harness 都给只读工具留了并发路径——codex 的 `can_run_in_parallel`、
// deepseek-harness 的 `executionMode` 分类器（只有明确声明可并行才并行）、
// ZCode 工具条目上的 `metadata.concurrentSafe`、opencode 的并行 dispatch。
// 之前 CaDt 是一轮内 for + await 全串行：模型一轮读 5 个文件就是 5 次串行往返。
//
// 并发的边界很硬：**只有「只读、不弹审批、无副作用」的工具能并发**。写文件、执行命令、
// 派子代理、提交类 MCP 都带顺序语义或审批，必须串行；未知工具一律串行。
// 批次内的相对顺序不变（按调用出现顺序执行），所以 UI 与消息顺序不受影响。

// 可并发的内置只读工具。这里刻意只列「参数里带路径 / 纯查询」的那几个：
// - read_file / list_dir / search_text / glob：彼此独立，读多份文件是典型场景；
// - memory_read / skill_list 之类虽然也只读，但不影响墙钟时间，先不放开（免得扩大面）。
export const PARALLEL_READ_TOOLS = ['read_file', 'list_dir', 'search_text', 'glob'];

// 单批并发上限：模型一轮给出 20 个 read_file 时，一次开 20 个句柄没有意义，
// 4 个足够把往返时间压下来，也留出余量给用户点停止。
export const PARALLEL_MAX_BATCH = 4;

export function isParallelToolCall(name) {
    return PARALLEL_READ_TOOLS.indexOf(String(name == null ? '' : name)) >= 0;
}

// groupToolCalls：把一轮的调用序列切成执行批次（保持原顺序）。
// eligible(call) 由调用方给：除了工具名，还可能要判断「路径是否在工作区内」——
// 工作区外的读会弹审批卡，两张卡同时弹会互相挡住，那种情况必须退回串行。
// 相邻且都 eligible 的调用合成一批（不超过 maxBatch），其余每个调用自成一批。
export function groupToolCalls(calls, eligible, maxBatch = PARALLEL_MAX_BATCH) {
    const list = Array.isArray(calls) ? calls : [];
    const allow = typeof eligible === 'function' ? eligible : (call) => isParallelToolCall(call && call.name);
    const cap = Math.max(1, Number(maxBatch) || PARALLEL_MAX_BATCH);
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const call = list[i];
        if (!call) continue;
        if (!allow(call)) {
            out.push([call]);
            continue;
        }
        const run = [call];
        while (run.length < cap && i + 1 < list.length && allow(list[i + 1])) run.push(list[++i]);
        out.push(run);
    }
    return out;
}
