import {parseStructure} from './structure.js';

self.onmessage = (event) => {
    const data = event.data || {};
    try {
        const result = parseStructure(data.name, data.text);
        self.postMessage({id: data.id, ok: true, result});
    } catch (e) {
        self.postMessage({id: data.id, ok: false, error: String((e && e.message) || e)});
    }
};
