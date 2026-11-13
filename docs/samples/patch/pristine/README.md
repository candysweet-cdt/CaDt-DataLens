# 补丁示例工程

`docs/samples/patch/` 里的三个 `.patch` 都以本目录为工作区根。

| 文件 | 说明 |
| --- | --- |
| `src/config.js` | 配置项。三个示例都会改它，但只有一个能成功。 |
| `src/message.js` | 消息文案，`partial.patch` 会改它。 |
| `src/style.css` | 样式，`all-success.patch` 与 `partial.patch` 会改它。 |
| `src/banner.js` | **初始不存在**，`all-success.patch` 会新建它。 |

跑完示例后，回到 `docs/samples/patch/` 执行 `reset-samples.ps1`（或 `./reset-samples.sh`）即可还原，
它会同时删除示例新建的 `src/banner.js` 和应用留下的 `.cadt/` 目录。
