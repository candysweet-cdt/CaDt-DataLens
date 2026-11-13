// 未解析引用审计：引用集 = 所有 Identifier（排除 key/属性/成员）− 声明集（全文件）− 全局
import {parseAst} from './node_modules/rollup/dist/es/parseAst.js';
import {readFileSync} from 'node:fs';
const GLOBAL=new Set('window document console JSON Math Date Object Array String Number Boolean Promise Map Set WeakMap WeakSet Error RegExp Symbol parseInt parseFloat isNaN isFinite setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame queueMicrotask fetch localStorage sessionStorage navigator location atob btoa encodeURIComponent decodeURIComponent structuredClone AbortController Blob File FileReader URL URLSearchParams TextEncoder TextDecoder Uint8Array Uint16Array Uint32Array Int32Array Float32Array Float64Array ArrayBuffer BigInt Image CustomEvent Event DOMParser Intl performance matchMedia getComputedStyle Node Element HTMLElement MutationObserver ResizeObserver IntersectionObserver CSS undefined this arguments globalThis Infinity NaN eval alert crypto self EventSource WebSocket FormData Headers Request Response Worker Proxy Reflect Range Selection process import hasWails Shiki shiki mermaid ace AceUndoManager ClipboardItem DataTransfer FileList DOMTokenList DOMRect getSelection history screen DOMParser CSSStyleSheet resolve reject Wails runtime go hljs JSONEditor DOMPurify encodeURI KeyboardEvent'.split(/\s+/));
function audit(file){
  const ast=parseAst(readFileSync(file,'utf8'));
  const declared=new Set();
  const missing=new Map();
  // 预遍历：先收集全文件所有绑定名（含提升）
  const collectOnly=(n)=>{ if(!n||typeof n!=='object')return;
    switch(n.type){
      case 'Identifier': return;
      case 'MemberExpression': collectOnly(n.object); return;
      case 'Property': if(n.value)collectOnly(n.value); return;
      case 'VariableDeclarator': bindPat(n.id); return;
      case 'FunctionDeclaration': if(n.id)declared.add(n.id.name); for(const p of (n.params||[]))bindPat(p); collectOnly(n.body); return;
      case 'FunctionExpression': if(n.id)declared.add(n.id.name); for(const p of (n.params||[]))bindPat(p); collectOnly(n.body); return;
      case 'ArrowFunctionExpression': for(const p of (n.params||[]))bindPat(p); collectOnly(n.body); return;
      case 'CatchClause': bindPat(n.param); collectOnly(n.body); return;
      case 'ImportDeclaration': for(const sp of n.specifiers)declared.add(sp.local.name); return;
      case 'ExportNamedDeclaration': if(n.declaration)collectOnly(n.declaration); for(const sp of (n.specifiers||[])){if(sp.local)declared.add(sp.local.name); if(sp.exported)declared.add(sp.exported.name);} return;
      case 'ClassDeclaration': case 'ClassExpression': if(n.id)declared.add(n.id.name); for(const el of (n.body.body||[]))collectOnly(el); return;
      case 'MethodDefinition': if(n.computed&&n.key)collectOnly(n.key); collectOnly(n.value); return;
      case 'PropertyDefinition': if(n.computed&&n.key)collectOnly(n.key); if(n.value)collectOnly(n.value); return;
      default: { for(const k of Object.keys(n)){ if(['loc','start','end','type','id','key','property','params','tag','meta'].includes(k))continue; const v=n[k]; if(Array.isArray(v)){for(const c of v)if(c&&typeof c==='object')collectOnly(c);} else if(v&&typeof v==='object'&&v.type)collectOnly(v); } }
    }
  };
  collectOnly(ast);
  function bindPat(pat){ if(!pat)return;
    if(pat.type==='Identifier')declared.add(pat.name);
    else if(pat.type==='ObjectPattern')for(const p of pat.properties){bindPat(p.value); if(p.argument)bindPat(p.argument);}
    else if(pat.type==='ArrayPattern')for(const e of pat.elements)bindPat(e);
    else if(pat.type==='AssignmentPattern')bindPat(pat.left);
    else if(pat.type==='RestElement')bindPat(pat.argument);
  }
  const walk=(n)=>{
    if(!n||typeof n!=='object')return;
    switch(n.type){
      case 'Identifier':
        if(n.name==='undefined')return;
        // 已在父级处理排除的（key/property/member）不会到达这里
        if(!declared.has(n.name)&&!GLOBAL.has(n.name)){
          const line=n.loc?n.loc.start.line:0;
          if(!missing.has(n.name))missing.set(n.name, line);
        }
        return;
      case 'MemberExpression': walk(n.object); return;
      case 'Property': if(n.value)walk(n.value); return; // key 排除；shorthand 的 value 是同名引用 ✓
      case 'VariableDeclarator': bindPat(n.id); if(n.init)walk(n.init); return;
      case 'FunctionDeclaration': if(n.id)declared.add(n.id.name); for(const p of (n.params||[]))bindPat(p); if(n.body)walk(n.body); return;
      case 'FunctionExpression': if(n.id)declared.add(n.id.name); for(const p of (n.params||[]))bindPat(p); if(n.body)walk(n.body); return;
      case 'ArrowFunctionExpression': for(const p of (n.params||[]))bindPat(p); if(n.body)walk(n.body); return;
      case 'ClassDeclaration': case 'ClassExpression': if(n.id)declared.add(n.id.name); if(n.superClass)walk(n.superClass); for(const el of (n.body.body||[]))walk(el); return;
      case 'MethodDefinition': if(n.computed&&n.key)walk(n.key); walk(n.value); return;
      case 'PropertyDefinition': if(n.computed&&n.key)walk(n.key); if(n.value)walk(n.value); return;
      case 'CatchClause': bindPat(n.param); walk(n.body); return;
      case 'ImportDeclaration': for(const sp of n.specifiers)declared.add(sp.local.name); return;
      case 'ExportNamedDeclaration': if(n.declaration)walk(n.declaration); for(const sp of (n.specifiers||[])){if(sp.local)declared.add(sp.local.name); if(sp.exported)declared.add(sp.exported.name);} return;
      case 'ExportDefaultDeclaration': if(n.declaration)walk(n.declaration); return;
      case 'LabeledStatement': walk(n.body); return;
      default: {
        for(const k of Object.keys(n)){
          if(['loc','start','end','type','id','key','property','params','tag','meta'].includes(k))continue;
          const v=n[k];
          if(Array.isArray(v)){for(const c of v)if(c&&typeof c==='object')walk(c);}
          else if(v&&typeof v==='object'&&v.type)walk(v);
        }
      }
    }
  };
  walk(ast);
  if(missing.size){ console.log(file+':'); for(const [nm,ln] of missing)console.log('  未解析: '+nm+' @line '+ln); return false; }
  return true;
}
const files=['cursor-themes','terminal-ui','bridge-ui','format-convert','update-check','app-links','properties-ui','session-restore','app-actions','quick-switch','schema-panel','diff-dialog','json-query','global-search','find-bar','activity-pane','menu-bar','mode-switch','settings-ui','writing-ui','editor-groups','ai-constants'];
let allOk=true;
for(const f of files){ if(!audit('src/'+(f.startsWith('ai-')?'ai/':'')+f+'.js')) allOk=false; }
if(!audit('src/main.js')) allOk=false;
console.log(allOk?'全部通过':'存在问题');
