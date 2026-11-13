// 补丁示例用的配置（docs/samples/patch）
export const config = {
    theme: 'light',
    pageSize: 20,
    locale: 'zh-CN',
    features: {
        patchView: false,
        aiPanel: true,
    },
};

export function describe() {
    return config.theme + ' / ' + config.pageSize;
}
