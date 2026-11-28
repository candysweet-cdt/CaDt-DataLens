---
name: cadt-gen-models
description: 帮用户配置生图/视频生成条目（generate_image / generate_video 的服务商配置）：代填除 API Key 外的全部字段，密钥由用户在设置里填写
---

# 生成条目配置（cadt-gen-models）

用户要接入生图/视频服务商时，用 app_control 的 get_gen_models / set_gen_model / delete_gen_model 代填配置（动作签名见 cadt-ui 技能）。**API Key 永远由用户自己填**——你写不了也读不了密钥。

## 条目字段

- name：条目名，**建议直接用服务商的模型 id**（generate_image 传 model=条目名 就能精准选中）。
- kind：image（生图）或 video（视频）。
- baseURL + path：服务根地址与生成端点。同步型（响应直接带产物）只填 path；任务型接口（提交→轮询）另填 submitPath / jobIdPath / pollPath（支持 {{jobId}}）/ statusPath / doneValue / failedValue / pollIntervalSec(2-30) / maxPolls(1-240)。
  任务型若跑完只给本机路径、不给可下载地址（url 为空），另填 probePath（产物下载端点，支持 {{jobId}}，形如 /v1/videos/{{jobId}}/content）：轮询时探一次，2xx 即视为完成、产物直接用该 URL 下载（下载会带同一套请求头，产物端点通常要鉴权）。
- headers：[{key,value}]，鉴权写 Authorization: Bearer {{apiKey}}——{{apiKey}} 会被替换为用户填的密钥。
- bodyTemplate：请求体模板。占位符渲染为 JSON 字面量（字符串自动带引号转义），**模板里不要手写引号**：{"prompt":{{prompt}}} 对，"prompt":"{{prompt}}" 错。可用占位符：prompt / model / size / n / seed / apiKey / jobId / images。
- 图生图（参考图编辑）：填 editPath（编辑端点）。两种请求体格式由 editFormat 选择：
  · json（缺省，多数服务商）：在 bodyTemplate 里放 {{images}}（已渲染成数组，不要再包引号：{"model":{{model}},"images":{{images}},"prompt":{{prompt}},"size":"auto"}）。editImageWrap 是参考图数组元素的字段名，缺省 image_url（[{"image_url":"…"}]），留空 = 裸字符串数组 ["…"]。
  · multipart：编辑端点收 FormData（Qwen-Image、OpenAI 官方 /v1/images/edits）时设 editFormat=multipart；参考图按 editImageWrap 命名的**文件字段**重复提交（缺省 image），bodyTemplate 只提供其余文本字段（不需要 {{images}}，模板须是合法 JSON 对象）。此格式只接受**本地图片**（URL 参考图会报错，需换本地文件）。
  异步型条目仍不支持参考图。
- resultType：b64（响应内嵌 base64，生成后直接解码落盘）或 url（响应给下载地址，生成后立即下载落盘，24h 限期无影响）；resultPath 如 data[*].url / data[*].b64_json（[*] 取多张）；errorPath 如 error.message，失败文案会回给 AI。
- defaultModel / defaultSize / defaultN(1-4)：工具未传参时的缺省值。
- seed：generate_image / generate_video 都支持 seed 参数；用户不指定时软件自动生成随机 seed（避免相同提示词出完全一样的结果，如 Qwen-Image）。**随机 seed 只有在条目 bodyTemplate 里放了 {{seed}} 才会发给服务端**——接入这类服务时记得在模板里加 "seed":{{seed}}；用户传了具体 seed 则原样尊重，用于复现同一张图。
- enabled：停用的条目不参与缺省解析，generate_* 工具也不会下发（全部停用时工具消失）。

## 工作流

1. get_gen_models 防重名、了解已有条目。
2. 按服务商文档写 bodyTemplate。最常见形态（OpenAI 兼容同步生图）：path=/v1/images/generations，bodyTemplate={"model":{{model}},"prompt":{{prompt}},"size":{{size}},"n":{{n}},"response_format":"url"}，resultType=url，resultPath=data[*].url，errorPath=error.message。
3. set_gen_model 保存（部分更新语义：改一处不必重发全量）。
4. **创建/更新后必须提醒用户**：去 设置 → AI → 生图与视频 → 编辑 填 API Key，并逐字核对 baseURL 与服务商文档一致。
5. 用户填完 Key 之前不要发起 generate_image（会因缺密钥失败）。
6. 图生图：条目配好 editPath（JSON 型还要在模板里放 {{images}}）后，generate_image 传 reference（至多 5 张、单张 ≤4MB：工作区路径 / 已授权的绝对路径 / http(s) 图片地址）即走编辑端点；prompt 写「怎么改」而不是「画什么」。缺 editPath、JSON 型模板没有 {{images}}、异步条目、multipart 型传 URL 图都会直接报错，不要靠重试绕。

## 红线

- 不写、不猜测、不占位 apiKey；已填密钥的条目更新时密钥自动保留，删除会被拒绝（让用户手动删）。
- baseURL 必须来自用户给出的服务商文档，不要编造域名；保存后明确提醒用户核对。
- 仅支持 n=1 的接口在模板里硬编码 "n":1，并在回复里说明分次调用。
