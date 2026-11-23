// ai-usage-templates.js：额度查询的模板与套餐预设（纯数据 + 变量替换纯函数，可单测）。
// 结构对齐 cc-switch 的 UsageScriptModal：request + extractor 两段式脚本（对象字面量），
// 变量 {{baseUrl}} / {{apiKey}} 与 extraFields 里的 {{key}} 在发送前整体替换；
// extractor 在 Worker 沙箱执行（沙箱拼装见 ai-usage-quota.js）。
// Token Plan 预设的端点与解析逐家移植自 cc-switch src-tauri/src/services/coding_plan.rs
// （kimi / zhipu / zhipu_team / minimax / zenmux / opencode_go / ollama_cloud）；
// OAuth 模板走通用 OAuth 引擎（Go internal/oauthquota）：账号密码登录后拿控制台 token，
// 再带 token 发请求、由本文件的 extractor 解析。SenseNova Token Plan 是第一个 OAuth provider。
// 火山方舟要 OpenAPI SigV4 签名、CommandCode 要三连请求，单请求管线承载不了，不做预设。

export const USAGE_TEMPLATE_KEYS = ['official', 'general', 'newapi', 'sub2api', 'plan', 'oauth', 'custom'];

export const USAGE_TEMPLATE_LABELS = {
    official: '官方',
    general: '通用模板',
    newapi: 'NewAPI',
    sub2api: 'Sub2API',
    plan: 'Token Plan',
    oauth: 'OAuth',
    custom: '自定义',
};

// 有「官方」白名单引擎覆盖的服务商 host（与 Go internal/aiusage 的端点表同一份口径）。
export const OFFICIAL_USAGE_HOSTS = ['api.deepseek.com', 'openrouter.ai', 'api.siliconflow.cn', 'api.siliconflow.com'];

// Token Plan 套餐档位显示名（预设 extractor 里的 planName 与此对齐）。
export const USAGE_TIER_LABELS = {
    five_hour: '5 小时',
    weekly: '每周',
    monthly: '每月',
};

// ── 脚本模板 ─────────────────────────────────────────────────
// 模板脚本统一是 `({ request: {...}, extractor: function (response) {...} })`：
// request 由沙箱在 run 阶段取走（url/method/headers/body），extractor 在 response
// 阶段拿解析后的响应体，返回 UsageItem 或其数组（缺 remaining/used/total 即判失败）。

const TEMPLATE_GENERAL = `({
  request: {
    url: "{{baseUrl}}".replace(/\\/+$/, "") + "/user/balance",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}",
      "Accept": "application/json"
    }
  },
  extractor: function (response) {
    return {
      isValid: response.is_active !== false,
      invalidMessage: response.is_active === false ? "账户已停用" : "",
      remaining: Number(response.balance),
      unit: "USD"
    };
  }
})`;

const TEMPLATE_NEWAPI = `({
  request: {
    url: "{{baseUrl}}".replace(/\\/+$/, "") + "/api/user/self",
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": "Bearer {{accessToken}}",
      "New-Api-User": "{{userId}}"
    }
  },
  extractor: function (response) {
    if (response && response.success && response.data) {
      var quota = Number(response.data.quota), usedQuota = Number(response.data.used_quota);
      return {
        planName: String(response.data.group || "默认分组"),
        remaining: quota / 500000,
        used: usedQuota / 500000,
        total: (quota + usedQuota) / 500000,
        unit: "USD"
      };
    }
    return { isValid: false, invalidMessage: (response && response.message) || "查询失败" };
  }
})`;

const TEMPLATE_SUB2API = `({
  request: {
    // Sub2API 的 /v1/usage 用 API Key 认证；供应商地址带不带 /v1 都能拼出同一个地址。
    // 订阅分组不限量时 remaining 为 -1，展示成 ∞ 而不是余额
    url: "{{baseUrl}}".replace(/\\/+$/, "").replace(/\\/v1$/, "") + "/v1/usage",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}",
      "Accept": "application/json"
    }
  },
  extractor: function (response) {
    var quota = (response && response.quota) || {};
    var item = {
      isValid: (response && response.isValid) !== false,
      unit: (response && response.unit) || quota.unit || "USD"
    };
    if (response && typeof response.planName === "string") item.planName = response.planName;
    if (response && typeof response.remaining === "number" && response.remaining >= 0) {
      item.remaining = response.remaining;
    }
    if (Number(quota.limit) > 0) {
      item.used = Number(quota.used);
      item.total = Number(quota.limit);
    }
    if (item.isValid === false) item.invalidMessage = String((response && response.status) || "查询失败");
    return item;
  }
})`;

const TEMPLATE_CUSTOM = `({
  request: {
    url: "{{baseUrl}}/user/balance",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}"
    }
  },
  extractor: function (response) {
    return {
      remaining: Number(response.balance),
      unit: "USD"
    };
  }
})`;

// ── Token Plan 套餐预设（端点移植自 cc-switch coding_plan.rs）──────────────

const PLAN_KIMI = `({
  // Kimi For Coding：GET {base}/v1/usages，Bearer 认证；limits[] 是 5h 滚动窗，usage 是周限额
  request: {
    url: "{{baseUrl}}".replace(/\\/+$/, "").replace(/\\/v1$/, "") + "/v1/usages",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}", "Accept": "application/json" }
  },
  extractor: function (response) {
    var items = [];
    if (response && Array.isArray(response.limits)) {
      for (var i = 0; i < response.limits.length; i++) {
        var d = (response.limits[i] || {}).detail || {};
        var limit = Number(d.limit), remaining = Number(d.remaining);
        if (!isFinite(limit) || !isFinite(remaining) || limit <= 0) continue;
        items.push({
          planName: "5 小时",
          used: Math.max(0, (limit - remaining) / limit * 100),
          unit: "%",
          resetAt: d.resetTime || 0
        });
      }
    }
    if (response && response.usage) {
      var u = response.usage, ul = Number(u.limit), ur = Number(u.remaining);
      if (isFinite(ul) && isFinite(ur) && ul > 0) {
        items.push({
          planName: "每周",
          used: Math.max(0, (ul - ur) / ul * 100),
          unit: "%",
          resetAt: u.resetTime || 0
        });
      }
    }
    if (!items.length) throw new Error("响应缺少 limits/usage 字段");
    return items;
  }
})`;

const PLAN_ZHIPU_EXTRACTOR = `  extractor: function (response) {
    if (response && response.success === false) throw new Error(String(response.msg || "API error"));
    var data = response && response.data;
    if (!data) throw new Error("响应缺少 data 字段");
    var limits = Array.isArray(data.limits) ? data.limits : [];
    var items = [];
    for (var i = 0; i < limits.length; i++) {
      var item = limits[i] || {};
      var type = String(item.type || "").toUpperCase();
      if (type !== "TOKENS_LIMIT" && type !== "CREDIT_LIMIT") continue;
      var pct = Number(item.percentage);
      if (!isFinite(pct)) continue;
      var reset = Number(item.nextResetTime);
      items.push({
        planName: Number(item.unit) === 6 ? "每周" : "5 小时",
        used: pct,
        unit: "%",
        resetAt: reset > 0 ? reset : 0
      });
    }
    if (!items.length) throw new Error("响应里没有额度条目（账户可能没有套餐）");
    return items;
  }
`;

const PLAN_ZHIPU = `({
  // 智谱 GLM：GET /api/monitor/usage/quota/limit，Authorization 直接放 Key（无 Bearer 前缀）；
  // bigmodel.cn 与 api.z.ai 共用同一后端，按账号地址选站
  request: {
    url: "{{baseUrl}}".toLowerCase().indexOf("bigmodel.cn") >= 0
      ? "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
      : "https://api.z.ai/api/monitor/usage/quota/limit",
    method: "GET",
    headers: {
      "Authorization": "{{apiKey}}",
      "Content-Type": "application/json",
      "Accept-Language": "en-US,en"
    }
  },
${PLAN_ZHIPU_EXTRACTOR}})`;

const PLAN_ZHIPU_TEAM = `({
  // 智谱团队版：与个人版同路径 + ?type=2，额外要 bigmodel-organization / bigmodel-project
  // 两个头（extraFields 里的 {{orgId}} / {{projectId}}）；团队版仅国内站
  request: {
    url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2",
    method: "GET",
    headers: {
      "Authorization": "{{apiKey}}",
      "bigmodel-organization": "{{orgId}}",
      "bigmodel-project": "{{projectId}}",
      "Content-Type": "application/json",
      "Accept-Language": "en-US,en"
    }
  },
${PLAN_ZHIPU_EXTRACTOR}})`;

const PLAN_MINIMAX = `({
  // MiniMax：额度接口只在 minimaxi.com / minimax.io 有公开出处；国内推理域
  // api.minimax.cn 沿用同一账号体系查 minimaxi.com。model_remains 只取 general
  //（编程套餐），5h 桶恒有；周桶 status=3 表示无周限额（remaining 恒 100），跳过
  request: {
    // host 标签边界匹配（cc-switch 同口径）：api.minimax.cn.example.com 这类伪造后缀不命中
    url: /(^|\.)(api\.minimax\.cn|api\.minimaxi\.com)(?=[:/?#]|$)/i.test("{{baseUrl}}")
      ? "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains"
      : "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}", "Content-Type": "application/json" }
  },
  extractor: function (response) {
    var base = (response && response.base_resp) || {};
    // status_code 缺省按 -1 报错（cc-switch unwrap_or(-1) 同语义）；base_resp 整体缺失视为成功
    if (response && response.base_resp) {
      var code = base.status_code === undefined ? -1 : Number(base.status_code);
      if (code !== 0) {
        throw new Error("API error (code " + code + "): " + (base.status_msg || "未知错误"));
      }
    }
    var remains = (response && response.model_remains) || [];
    var item = null;
    for (var i = 0; i < remains.length; i++) {
      if (remains[i] && remains[i].model_name === "general") { item = remains[i]; break; }
    }
    if (!item) throw new Error("响应缺少 model_remains.general 字段");
    var items = [];
    var interval = Number(item.current_interval_remaining_percent);
    if (isFinite(interval)) {
      var endTime = Number(item.end_time);
      items.push({
        planName: "5 小时",
        used: Math.max(0, 100 - interval),
        unit: "%",
        resetAt: endTime > 0 ? endTime : 0
      });
    }
    var weeklyStatus = Number(item.current_weekly_status);
    var weekly = Number(item.current_weekly_remaining_percent);
    if ((weeklyStatus === 1 || weeklyStatus === 2) && isFinite(weekly)) {
      var weekEnd = Number(item.weekly_end_time);
      items.push({
        planName: "每周",
        used: Math.max(0, 100 - weekly),
        unit: "%",
        resetAt: weekEnd > 0 ? weekEnd : 0
      });
    }
    if (!items.length) throw new Error("响应里没有可展示的额度窗口");
    return items;
  }
})`;

const PLAN_ZENMUX = `({
  // ZenMux：按 cc-switch 的移植口径直接查账号 base_url（quota 字段在其 API 根返回）；
  // usage_percentage 是 0-1 的小数，乘 100 成已用百分比
  request: {
    url: "{{baseUrl}}".replace(/\\/+$/, ""),
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}", "Accept": "application/json" }
  },
  extractor: function (response) {
    if (!response || response.success !== true) {
      throw new Error(String((response && response.message) || "查询失败"));
    }
    var data = response.data;
    if (!data) throw new Error("响应缺少 data 字段");
    var items = [];
    var windows = [["quota_5_hour", "5 小时"], ["quota_7_day", "每周"]];
    for (var i = 0; i < windows.length; i++) {
      var w = data[windows[i][0]];
      if (!w) continue;
      var pct = Number(w.usage_percentage);
      if (!isFinite(pct)) continue;
      var extra = "";
      if (Number.isFinite(Number(w.used_value_usd)) && Number.isFinite(Number(w.max_value_usd))) {
        extra = "已用 $" + Number(w.used_value_usd).toFixed(2) + " / $" + Number(w.max_value_usd).toFixed(2);
      }
      items.push({ planName: windows[i][1], used: pct * 100, unit: "%", extra: extra, resetAt: w.resets_at || 0 });
    }
    if (!items.length) throw new Error("响应里没有 quota 窗口字段");
    return items;
  }
})`;

const PLAN_OPENCODE_GO = `({
  // OpenCode Go：GET /zen/go/v1/usage 只认 Authorization: Bearer（推理侧 /messages
  // 反而只认 x-api-key，不能互换）。rolling/weekly/monthly 的 percent 是已用整数
  request: {
    url: "https://opencode.ai/zen/go/v1/usage",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}", "Accept": "application/json" }
  },
  extractor: function (response) {
    var usage = response && response.usage;
    if (!usage) throw new Error("响应缺少 usage 字段");
    var items = [];
    var windows = [["rolling", "5 小时"], ["weekly", "每周"], ["monthly", "每月"]];
    for (var i = 0; i < windows.length; i++) {
      var w = usage[windows[i][0]];
      if (!w) continue;
      var pct = Number(w.percent);
      if (!isFinite(pct)) continue;
      items.push({
        planName: windows[i][1],
        used: pct,
        unit: "%",
        resetAt: pct > 0 ? (w.resetsAt || 0) : 0
      });
    }
    if (!items.length) throw new Error("响应形态不认识（未文档化端点可能又变了）");
    return items;
  }
})`;

const PLAN_OLLAMA = `({
  // Ollama Cloud：GET /api/balance。现行套餐 included.balance_usd / allowance_usd
  // 折成月度百分比；旧套餐是 session/weekly 两档 remaining_percent。另购余额不进额度档
  request: {
    url: "https://ollama.com/api/balance",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}", "Accept": "application/json" }
  },
  extractor: function (response) {
    var included = response && response.included;
    if (!included) throw new Error("响应缺少 included 字段");
    var balance = Number(included.balance_usd), allowance = Number(included.allowance_usd);
    var items = [];
    if (isFinite(balance) && isFinite(allowance) && allowance > 0) {
      var used = Math.min(Math.max(allowance - balance, 0), allowance);
      var until = included.period && included.period.until;
      items.push({
        planName: "每月",
        used: used / allowance * 100,
        unit: "%",
        extra: "本期剩余 $" + balance.toFixed(2) + " / $" + allowance.toFixed(2) + (until ? " · 至 " + until : "")
      });
      return items;
    }
    var windows = [["session", "5 小时"], ["weekly", "每周"]];
    for (var i = 0; i < windows.length; i++) {
      var w = included[windows[i][0]];
      if (!w) continue;
      var remaining = Number(w.remaining_percent);
      if (!isFinite(remaining)) continue;
      items.push({
        planName: windows[i][1],
        used: Math.min(Math.max(100 - remaining, 0), 100),
        unit: "%",
        resetAt: w.resets_at || 0
      });
    }
    if (!items.length) {
      if (isFinite(allowance) && allowance <= 0) throw new Error("按量付费账户没有套餐额度");
      throw new Error("响应形态不认识");
    }
    return items;
  }
})`;

// Token Plan 套餐预设：id ↔ cc-switch codingPlanProvider 对齐。
// ── OAuth 模板（通用引擎 + provider 配置）────────────────────────
// providerId 对应 Go internal/oauthquota 内置表；script 是「带 token 请求」的规格，
// 由通用 OAuth 引擎发（不是 aigen 哑通道），响应仍走同一 Worker 沙箱 extractor。
// SenseNova：GET {consoleOrigin}/lite/console/v1/tokenplan/pool-usage
// 响应 {plan, pools:[{name, window_5h:{limit,used,remaining,reset_at}, window_7d:{...},
// grant_balance, nearest_grant_expiry}]}——逐池出 5h/7d 两档已用% + remaining + 重置时间。
export const USAGE_OAUTH_PROVIDERS = [
    {
        id: 'sensenova',
        label: 'SenseNova',
        script: `({
  request: {
    url: "https://platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage",
    method: "GET"
  },
  extractor: function (response) {
    var pools = (response && response.pools) || [];
    if (!pools.length) throw new Error("账号没有 Token Plan 额度池（按量付费账号查不到套餐）");
    var items = [];
    var windows = [["window_5h", "5 小时"], ["window_7d", "每周"]];
    for (var i = 0; i < pools.length; i++) {
      var pool = pools[i] || {};
      var poolName = String(pool.name || pool.id || ("池 " + (i + 1)));
      for (var w = 0; w < windows.length; w++) {
        var win = pool[windows[w][0]] || {};
        var limit = Number(win.limit), used = Number(win.used), remaining = Number(win.remaining);
        if (!isFinite(limit) || limit <= 0) continue;
        var resetAt = Number(win.reset_at || win.resetAt);
        items.push({
          planName: poolName + " · " + windows[w][1],
          poolName: poolName,
          used: Math.max(0, Math.min(100, used / limit * 100)),
          remaining: Math.max(0, remaining),
          total: limit,
          unit: "%",
          resetAt: resetAt > 0 ? resetAt * 1000 : 0,
          extra: Number(pool.grant_balance) > 0 ? "返赠 " + Number(pool.grant_balance) : "",
          grantBalance: i === 0 && Number(pool.grant_balance) > 0 ? Number(pool.grant_balance) : 0
        });
      }
    }
    if (!items.length) throw new Error("额度池里没有可展示的窗口");
    return items;
  }
})`,
    },
];

export const USAGE_OAUTH_PROVIDER_IDS = USAGE_OAUTH_PROVIDERS.map((item) => item.id);

export const USAGE_PLAN_PRESETS = [
    { id: 'kimi', label: 'Kimi For Coding', code: PLAN_KIMI },
    { id: 'zhipu', label: '智谱 GLM', code: PLAN_ZHIPU },
    { id: 'zhipu_team', label: '智谱 GLM 团队', code: PLAN_ZHIPU_TEAM },
    { id: 'minimax', label: 'MiniMax', code: PLAN_MINIMAX },
    { id: 'zenmux', label: 'ZenMux', code: PLAN_ZENMUX },
    { id: 'opencode_go', label: 'OpenCode Go', code: PLAN_OPENCODE_GO },
    { id: 'ollama_cloud', label: 'Ollama Cloud', code: PLAN_OLLAMA },
];

export const USAGE_PLAN_IDS = USAGE_PLAN_PRESETS.map((item) => item.id);

// 各预设要填的 extraFields 字段（{{key}} 变量），供弹窗渲染输入行。
export const USAGE_PLAN_FIELDS = {
    kimi: [],
    zhipu: [],
    zhipu_team: [
        { key: 'orgId', label: '组织 ID', placeholder: 'bigmodel-organization 请求头' },
        { key: 'projectId', label: '项目 ID', placeholder: 'bigmodel-project 请求头' },
    ],
    minimax: [],
    zenmux: [],
    opencode_go: [],
    ollama_cloud: [],
};

// newapi 模板的 extraFields 字段。
export const USAGE_NEWAPI_FIELDS = [
    { key: 'accessToken', label: 'Access Token', placeholder: 'NewAPI 的访问令牌（不是 API Key）' },
    { key: 'userId', label: '用户 ID', placeholder: 'New-Api-User 请求头' },
];

// 预设模板 → 脚本文本（official 不走脚本管线，code 恒空）。
export function usageTemplatePresetCode(template, planProvider) {
    switch (template) {
        case 'general': return TEMPLATE_GENERAL;
        case 'newapi': return TEMPLATE_NEWAPI;
        case 'sub2api': return TEMPLATE_SUB2API;
        case 'plan': {
            const preset = USAGE_PLAN_PRESETS.find((item) => item.id === planProvider);
            return preset ? preset.code : '';
        }
        case 'oauth': {
            const preset = USAGE_OAUTH_PROVIDERS.find((item) => item.id === planProvider);
            return preset ? preset.script : '';
        }
        case 'custom': return TEMPLATE_CUSTOM;
        default: return '';
    }
}

// 变量替换：{{baseUrl}} / {{apiKey}} / {{accessToken}} / {{userId}} / {{orgId}} / {{projectId}}。
// 与 cc-switch 同语义做整体字符串替换（不做 JS 字面量转义——key 是 token 形态文本，
// 含引号的值会让脚本语法错误并在测试脚本时报错，不会静默错查）。
export function renderUsageVars(code, vars) {
    let out = String(code || '');
    const map = vars && typeof vars === 'object' ? vars : {};
    for (const [key, value] of Object.entries(map)) {
        out = out.split('{{' + key + '}}').join(String(value));
    }
    return out;
}

// 自定义脚本 / 预设说明里允许出现的变量提示（弹窗展示用）。
export const USAGE_VAR_HINTS = [
    { key: 'baseUrl', label: '账号 Base URL（可被覆盖值替换）' },
    { key: 'apiKey', label: 'API Key（账号的或覆盖值）' },
    { key: 'accessToken', label: 'extraFields.accessToken' },
    { key: 'userId', label: 'extraFields.userId' },
    { key: 'orgId', label: 'extraFields.orgId' },
    { key: 'projectId', label: 'extraFields.projectId' },
];

// extractor 返回格式说明（弹窗 <details> 折叠展示）。
export const USAGE_SCRIPT_HELP = [
    '配置格式：({ request: { url, method, headers, body }, extractor: function (response) { return {...} } })',
    'extractor 返回字段（均可选）：isValid 布尔 · invalidMessage 失效说明 · remaining/total/used 数字 · unit 单位（如 USD / CNY / %）· planName 套餐名 · extra 附加文本；返回数组表示多套餐',
    '变量 {{baseUrl}} {{apiKey}} 与 extraFields 自定义键（如 {{accessToken}}）会在发送前替换',
    'extractor 在隔离 Worker 沙箱执行：没有网络与宿主 API，只有响应数据；语法错误在「测试脚本」时报出',
];
