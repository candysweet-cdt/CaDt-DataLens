// 零依赖 JSON Schema 常用关键字校验（type/properties/items/enum/数值与长度约束/组合关键字/本地 $ref）。

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pathKey(key) {
    return "['" + String(key).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "']";
}

function typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (Number.isInteger(value)) return 'integer';
    if (typeof value === 'number') return 'number';
    return typeof value; // string/boolean/object
}

function typeMatches(value, type) {
    const actual = typeOf(value);
    if (type === 'number') return actual === 'number' || actual === 'integer';
    return actual === type;
}

function resolvePointer(root, ref) {
    if (!ref || typeof ref !== 'string' || ref[0] !== '#') return null;
    if (ref === '#') return root;
    const body = ref.slice(1);
    if (!body.startsWith('/')) return null;
    const parts = body.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    let current = root;
    for (const part of parts) {
        if (current == null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
            return null;
        }
        current = current[part];
    }
    return current;
}

function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a == null || b == null) return false;
    if (typeof a !== 'object') return false;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch (e) {
        return false;
    }
}

export function validateJsonSchema(data, schema, options = {}) {
    const errors = [];
    const root = schema && typeof schema === 'object' ? schema : {};
    const maxErrors = Math.max(1, Math.min(1000, Number(options.maxErrors) || 200));
    let budget = maxErrors * 4;

    function push(path, keyword, message) {
        if (errors.length >= maxErrors) return;
        errors.push({path, keyword, message});
    }

    function validate(value, node, path, depth) {
        if (!node || typeof node !== 'object') return;
        if (depth > 64) {
            push(path, 'depth', 'Schema 引用层级过深（可能存在循环引用）');
            return;
        }
        if (errors.length >= maxErrors) return;
        if (budget-- <= 0) return;
        if (node.$ref) {
            const target = resolvePointer(root, node.$ref);
            if (!target) push(path, '$ref', '无法解析引用：' + node.$ref);
            else validate(value, target, path, depth + 1);
        }
        if (node.type != null) {
            const types = Array.isArray(node.type) ? node.type : [node.type];
            if (!types.some((type) => typeMatches(value, type))) {
                push(path, 'type', '应为 ' + types.join(' / ') + '，实际为 ' + typeOf(value));
            }
        }
        if (Object.prototype.hasOwnProperty.call(node, 'const') && !deepEqual(value, node.const)) {
            push(path, 'const', '应等于 ' + JSON.stringify(node.const));
        }
        if (Array.isArray(node.enum) && !node.enum.some((item) => deepEqual(value, item))) {
            push(path, 'enum', '应为枚举值之一：' + node.enum.map((item) => JSON.stringify(item)).join(', '));
        }
        if (typeof value === 'number') {
            if (node.minimum != null && value < node.minimum) push(path, 'minimum', '不能小于 ' + node.minimum);
            if (node.maximum != null && value > node.maximum) push(path, 'maximum', '不能大于 ' + node.maximum);
            if (node.exclusiveMinimum != null) {
                const limit = typeof node.exclusiveMinimum === 'boolean' ? node.minimum : node.exclusiveMinimum;
                if (typeof limit === 'number' && value <= limit) push(path, 'exclusiveMinimum', '必须大于 ' + limit);
            }
            if (node.exclusiveMaximum != null) {
                const limit = typeof node.exclusiveMaximum === 'boolean' ? node.maximum : node.exclusiveMaximum;
                if (typeof limit === 'number' && value >= limit) push(path, 'exclusiveMaximum', '必须小于 ' + limit);
            }
            if (node.multipleOf != null && node.multipleOf > 0) {
                const quotient = value / node.multipleOf;
                if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
                    push(path, 'multipleOf', '必须是 ' + node.multipleOf + ' 的整数倍');
                }
            }
        }
        if (typeof value === 'string') {
            const length = [...value].length;
            if (node.minLength != null && length < node.minLength) push(path, 'minLength', '长度不能小于 ' + node.minLength);
            if (node.maxLength != null && length > node.maxLength) push(path, 'maxLength', '长度不能大于 ' + node.maxLength);
            if (typeof node.pattern === 'string') {
                try {
                    if (!new RegExp(node.pattern).test(value)) push(path, 'pattern', '不匹配模式 ' + node.pattern);
                } catch (e) {
                    push(path, 'pattern', 'Schema 中的 pattern 无效：' + node.pattern);
                }
            }
        }
        if (Array.isArray(value)) {
            if (node.minItems != null && value.length < node.minItems) push(path, 'minItems', '至少需要 ' + node.minItems + ' 项');
            if (node.maxItems != null && value.length > node.maxItems) push(path, 'maxItems', '最多允许 ' + node.maxItems + ' 项');
            if (node.uniqueItems === true) {
                const seen = new Set();
                let duplicate = false;
                for (const item of value) {
                    let key;
                    try { key = JSON.stringify(item); } catch (e) { key = String(item); }
                    if (seen.has(key)) {
                        duplicate = true;
                        break;
                    }
                    seen.add(key);
                }
                if (duplicate) push(path, 'uniqueItems', '数组项必须唯一');
            }
            if (Array.isArray(node.items)) {
                for (let i = 0; i < value.length; i++) {
                    if (i < node.items.length) validate(value[i], node.items[i], path + '[' + i + ']', depth + 1);
                    else if (node.additionalItems === false) push(path + '[' + i + ']', 'additionalItems', '不允许额外的数组项');
                    else if (node.additionalItems && typeof node.additionalItems === 'object') {
                        validate(value[i], node.additionalItems, path + '[' + i + ']', depth + 1);
                    }
                }
            } else if (node.items && typeof node.items === 'object') {
                for (let i = 0; i < value.length; i++) validate(value[i], node.items, path + '[' + i + ']', depth + 1);
            }
        }
        if (isPlainObject(value)) {
            if (Array.isArray(node.required)) {
                for (const key of node.required) {
                    if (!Object.prototype.hasOwnProperty.call(value, key)) {
                        push(path + pathKey(key), 'required', '缺少必填字段 ' + key);
                    }
                }
            }
            const keys = Object.keys(value);
            if (node.minProperties != null && keys.length < node.minProperties) {
                push(path, 'minProperties', '至少需要 ' + node.minProperties + ' 个字段');
            }
            if (node.maxProperties != null && keys.length > node.maxProperties) {
                push(path, 'maxProperties', '最多允许 ' + node.maxProperties + ' 个字段');
            }
            const properties = node.properties && typeof node.properties === 'object' ? node.properties : {};
            const patternProperties = node.patternProperties && typeof node.patternProperties === 'object' ? node.patternProperties : {};
            for (const key of keys) {
                const childPath = path + pathKey(key);
                let matched = false;
                if (Object.prototype.hasOwnProperty.call(properties, key)) {
                    matched = true;
                    validate(value[key], properties[key], childPath, depth + 1);
                }
                for (const pattern of Object.keys(patternProperties)) {
                    try {
                        if (new RegExp(pattern).test(key)) {
                            matched = true;
                            validate(value[key], patternProperties[pattern], childPath, depth + 1);
                        }
                    } catch (e) {}
                }
                if (!matched && node.additionalProperties !== undefined) {
                    if (node.additionalProperties === false) {
                        push(childPath, 'additionalProperties', '不允许额外字段 ' + key);
                    } else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
                        validate(value[key], node.additionalProperties, childPath, depth + 1);
                    }
                }
            }
        }
        if (Array.isArray(node.allOf)) {
            for (const sub of node.allOf) validate(value, sub, path, depth + 1);
        }
        if (Array.isArray(node.anyOf)) {
            let ok = false;
            for (const sub of node.anyOf) {
                const before = errors.length;
                validate(value, sub, path, depth + 1);
                if (errors.length === before) {
                    ok = true;
                    break;
                }
                errors.length = before;
            }
            if (!ok) push(path, 'anyOf', '不满足 anyOf 的任一分支');
        }
        if (Array.isArray(node.oneOf)) {
            let matches = 0;
            for (const sub of node.oneOf) {
                const before = errors.length;
                validate(value, sub, path, depth + 1);
                if (errors.length === before) matches++;
                errors.length = before;
            }
            if (matches !== 1) push(path, 'oneOf', '必须且只能满足 oneOf 的一个分支（当前 ' + matches + '）');
        }
        if (node.not && typeof node.not === 'object') {
            const before = errors.length;
            validate(value, node.not, path, depth + 1);
            const passed = errors.length === before;
            errors.length = before;
            if (passed) push(path, 'not', '不得满足 not 指定的 Schema');
        }
        if (node.if && typeof node.if === 'object') {
            const before = errors.length;
            validate(value, node.if, path, depth + 1);
            const matched = errors.length === before;
            errors.length = before;
            if (matched && node.then) validate(value, node.then, path, depth + 1);
            else if (!matched && node.else) validate(value, node.else, path, depth + 1);
        }
    }

    validate(data, root, '$', 0);
    return errors;
}
