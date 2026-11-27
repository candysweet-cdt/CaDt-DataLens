// bridge-orchestration-view.js：编排看板的独立内容区标签页。
//
// 与「应用页面」入口共用同一个挂载器（main.js 的 orchestration mount）；这个标签页
// 只是把「某一条编排」作为业务对象打开，标题取 doc.orchestrationSpec.title。
// 视图型虚拟标签页的统一卸载契约是 doc.tabUnmount（closeDocNow 只调它）。
import {createVirtualTabDoc} from '../core/virtual-tab-doc.js';

export function createBridgeOrchestrationView(deps) {
    function openOrchestrationTab(spec) {
        const raw = spec && typeof spec === 'object' ? spec : {id: String(spec || '')};
        const id = String(raw.id || '').trim();
        if (!id) return null;
        const existing = deps.docs.find((d) => d.orchestration === id);
        if (existing) {
            deps.activateDoc(existing);
            return existing;
        }
        const title = String(raw.title || '编排').slice(0, 80);
        const doc = createVirtualTabDoc({
            id: 'orchestration-' + id,
            name: title,
            format: {id: 'orchestration', name: title, extensions: [], aceMode: 'text', rawOnly: true},
            mode: 'orchestration',
            marker: 'orchestration',
            key: id,
        });
        doc.orchestrationSpec = {id, title, workspace: String(raw.workspace || '')};
        deps.docs.push(doc);
        deps.addDocToFocusedGroup(doc);
        deps.activateDoc(doc);
        return doc;
    }

    function createOrchestrationView(doc) {
        const pane = document.createElement('div');
        pane.className = 'jsoneditor-pane active orchestration-pane';
        deps.els.editor.appendChild(pane);
        const scroll = document.createElement('div');
        scroll.className = 'apppage-scroll';
        pane.appendChild(scroll);
        const root = document.createElement('div');
        root.className = 'apppage-root';
        scroll.appendChild(root);
        doc.pane = pane;
        doc.orchestrationRoot = root;
        const mount = deps.orchestrationMount;
        if (typeof mount !== 'function') {
            root.textContent = '编排看板不可用：界面尚未就绪。';
            return;
        }
        const unmount = mount(root, (doc.orchestrationSpec && doc.orchestrationSpec.workspace) || '', {
            selected: doc.orchestrationSpec && doc.orchestrationSpec.id,
        });
        doc.tabUnmount = () => {
            if (typeof unmount === 'function') unmount();
            doc.tabUnmount = null;
            doc.orchestrationRoot = null;
        };
    }

    return {openOrchestrationTab, createOrchestrationView};
}