import {OS_ICONS} from './fileicons-os.js';

const BADGE_OPEN = '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<rect x="1.6" y="1.6" width="12.8" height="12.8" rx="3.2" fill="currentColor" opacity="0.13"></rect>' +
    '<rect x="1.6" y="1.6" width="12.8" height="12.8" rx="3.2" fill="none" stroke="currentColor" stroke-width="0.9" opacity="0.55"></rect>';

function label(text, size, y = 10.9, x = 8, weight = 700) {
    return '<text x="' + x + '" y="' + y + '" text-anchor="middle" fill="currentColor" font-family="\'JetBrains Mono\', Consolas, monospace" font-size="' +
        size + '" font-weight="' + weight + '">' + text + '</text>';
}

function badge(content) {
    return BADGE_OPEN + content + '</svg>';
}

const ICONS = {
    json: badge(label('{}', 6.4)),
    jsonl: badge(label('{}', 5.6, 8.6) +
        '<path d="M5.2 10.7h5.6M5.2 12.4h3.8" fill="none" stroke="currentColor" stroke-width="0.9" stroke-linecap="round"></path>'),
    yaml: badge(label('Y', 7.4, 11.1)),
    xml: badge(label('&lt;&gt;', 5.8, 11)),
    csv: badge('<path d="M4.8 4.8h6.4v6.4H4.8z" fill="none" stroke="currentColor" stroke-width="0.95"></path>' +
        '<path d="M4.8 7.9h6.4M4.8 10.1h6.4M8 4.8v6.4" fill="none" stroke="currentColor" stroke-width="0.8"></path>'),
    toml: badge(label('T', 7.4, 11.1)),
    ini: badge(label('=', 7.2, 11.1)),
    properties: badge(label('P', 7.2, 11.1)),
    md: badge(label('M', 6.6, 11.2, 6.3) +
        '<path d="M10.2 6.1v5.1M8.75 9.85l1.45 1.45 1.45-1.45" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linecap="round" stroke-linejoin="round"></path>'),
    text: badge('<path d="M4.9 5.4h6.2M4.9 7.7h6.2M4.9 10h6.2M4.9 12.3h4" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"></path>'),
    log: badge('<path d="M4.9 5.1h6.2M4.9 7.3h6.2M4.9 9.5h6.2M4.9 11.7h3.4" fill="none" stroke="currentColor" stroke-width="0.9" stroke-linecap="round"></path>'),
    patch: badge('<path d="M5.15 5.5h2.5M6.4 4.25v2.5" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"></path>' +
        '<path d="M9 10.5h2.5" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"></path>' +
        '<path d="M9.2 6.3h1.7M5.15 9.3h1.7M5.15 12.1h3.4" fill="none" stroke="currentColor" stroke-width="0.8" stroke-linecap="round" opacity="0.45"></path>'),
    image: badge('<circle cx="10.7" cy="5.9" r="1.05" fill="currentColor"></circle>' +
        '<path d="M4.5 11.4l2.4-3.2 1.55 1.95 1.15-1.4 2.1 2.65z" fill="currentColor"></path>'),
    binary: badge(label('01', 5.1)),
    js: badge(label('JS', 5.3)),
    ts: badge(label('TS', 5.3)),
    html: badge(label('&lt;&gt;', 5.5, 11)),
    css: badge(label('#', 7.4, 11.1)),
    py: badge(label('Py', 5.4)),
    sh: badge(label('&gt;_', 5.2)),
    ps: badge(label('PS', 5.2)),
    bat: badge(label('B', 7.4, 11.1)),
    sql: badge('<ellipse cx="8" cy="4.9" rx="3.2" ry="1.2" fill="currentColor"></ellipse>' +
        '<path d="M4.8 4.9v4.9c0 .7 1.43 1.25 3.2 1.25s3.2-.55 3.2-1.25V4.9" fill="none" stroke="currentColor" stroke-width="1"></path>' +
        '<path d="M4.8 7.4c0 .7 1.43 1.25 3.2 1.25s3.2-.55 3.2-1.25" fill="none" stroke="currentColor" stroke-width="0.9"></path>'),
    go: badge(label('Go', 5.3)),
    java: badge(label('J', 7.5, 11.1)),
    kotlin: badge(label('K', 7.5, 11.1)),
    lua: badge(label('L', 7.5, 11.1)),
    php: badge(label('PHP', 4.2)),
    rust: badge(label('Rs', 5.3)),
    cpp: badge(label('C++', 4.2)),
    csharp: badge(label('C#', 5.1)),
    docker: badge(label('D', 7.4, 11.1)),
    make: badge(label('MK', 5.1)),
    cmake: badge(label('CM', 5.1)),
};

// 补充图标：vscode-icons / material-icon-theme（均 MIT License）中未包含在生成子集里的常用类型
const OS_EXTRA_ICONS = {
    php: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><radialGradient id="a" cx="-16.114" cy="20.532" r="18.384" gradientTransform="translate(26.52 -9.307)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#4c6b96"/><stop offset="1" stop-color="#231f20"/></radialGradient></defs><ellipse cx="16" cy="16" fill="url(#a)" rx="14" ry="7.365"/><ellipse cx="16" cy="16" fill="#6280b6" rx="13.453" ry="6.818"/><path fill="#fff" d="m18.725 18.2.667-3.434a1.75 1.75 0 0 0-.372-1.719 2.93 2.93 0 0 0-2-.525h-1.153l.331-1.7a.22.22 0 0 0-.215-.26h-1.6a.22.22 0 0 0-.215.177l-.709 3.646a2.05 2.05 0 0 0-.477-1.054 2.78 2.78 0 0 0-2.2-.807H7.7a.22.22 0 0 0-.215.177l-1.434 7.38a.22.22 0 0 0 .215.26h1.603a.22.22 0 0 0 .215-.177l.347-1.785h1.2a5.2 5.2 0 0 0 1.568-.2 3.1 3.1 0 0 0 1.15-.689 3.5 3.5 0 0 0 .68-.844l-.287 1.475a.22.22 0 0 0 .215.26h1.6a.22.22 0 0 0 .215-.177l.787-4.051h1.094c.466 0 .6.093.64.133s.1.165.025.569l-.635 3.265a.22.22 0 0 0 .215.26h1.62a.22.22 0 0 0 .207-.18m-7.395-2.834a1.75 1.75 0 0 1-.561 1.092 2.17 2.17 0 0 1-1.315.321h-.712l.515-2.651h.921c.677 0 .949.145 1.059.266a1.18 1.18 0 0 1 .093.972m14.216-2.034a2.78 2.78 0 0 0-2.2-.807h-3.091a.22.22 0 0 0-.215.177l-1.434 7.38a.22.22 0 0 0 .215.26h1.608a.22.22 0 0 0 .215-.177l.347-1.785h1.2a5.2 5.2 0 0 0 1.568-.2 3.1 3.1 0 0 0 1.15-.689 3.43 3.43 0 0 0 1.076-1.927 2.51 2.51 0 0 0-.439-2.232m-1.667 2.034a1.75 1.75 0 0 1-.561 1.092 2.17 2.17 0 0 1-1.318.32h-.71l.515-2.651h.921c.677 0 .949.145 1.059.266a1.18 1.18 0 0 1 .094.973"/><path fill="#000004" d="M10.178 13.908a1.65 1.65 0 0 1 1.221.338 1.34 1.34 0 0 1 .145 1.161 1.95 1.95 0 0 1-.642 1.223 2.36 2.36 0 0 1-1.448.37h-.978l.6-3.089Zm-3.917 6.216h1.608l.381-1.962h1.377a5 5 0 0 0 1.5-.191 2.84 2.84 0 0 0 1.07-.642 3.2 3.2 0 0 0 1.01-1.808 2.3 2.3 0 0 0-.385-2.044 2.57 2.57 0 0 0-2.035-.732H7.7Zm8.126-9.342h1.6l-.387 1.962h1.421a2.77 2.77 0 0 1 1.85.468 1.55 1.55 0 0 1 .305 1.516l-.667 3.434H16.89l.635-3.265a.89.89 0 0 0-.08-.76 1.12 1.12 0 0 0-.8-.2H15.37l-.822 4.228h-1.6Zm8.34 3.126a1.65 1.65 0 0 1 1.221.338 1.34 1.34 0 0 1 .145 1.161 1.95 1.95 0 0 1-.642 1.223A2.36 2.36 0 0 1 22 17h-.978l.6-3.089Zm-3.917 6.216h1.608l.381-1.962h1.377a5 5 0 0 0 1.5-.191 2.84 2.84 0 0 0 1.07-.642 3.2 3.2 0 0 0 1.01-1.808 2.3 2.3 0 0 0-.385-2.044 2.57 2.57 0 0 0-2.035-.732h-3.092Z"/></svg>',
    rust: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><radialGradient id="a" cx="-492.035" cy="-883.37" r="13.998" gradientTransform="matrix(.866 -.5 -.3 -.52 177.106 -689.033)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7d7d7d"/><stop offset=".267" stop-color="#7e7c7a"/><stop offset=".45" stop-color="#817871"/><stop offset=".608" stop-color="#867162"/><stop offset=".753" stop-color="#8d684c"/><stop offset=".886" stop-color="#965c30"/><stop offset="1" stop-color="#a04f12"/></radialGradient></defs><path fill="url(#a)" d="M15.124 5.3a.832.832 0 1 1 .832.832.83.83 0 0 1-.832-.832M5.2 12.834a.832.832 0 1 1 .832.832.83.83 0 0 1-.832-.832m19.856.039a.832.832 0 1 1 .832.832.83.83 0 0 1-.832-.832m-17.451 1.14a.76.76 0 0 0 .386-1l-.369-.835h1.452v6.545h-2.93a10.3 10.3 0 0 1-.332-3.911Zm6.074.161v-1.929h3.458c.179 0 1.261.206 1.261 1.016 0 .672-.83.913-1.513.913ZM8.958 24.561a.832.832 0 1 1 .832.832.83.83 0 0 1-.832-.832m12.331.039a.832.832 0 1 1 .832.832.83.83 0 0 1-.832-.832m.257-1.887a.76.76 0 0 0-.9.584l-.418 1.949a10.25 10.25 0 0 1-8.545-.041l-.417-1.949a.76.76 0 0 0-.9-.583l-1.721.37a10 10 0 0 1-.89-1.049h8.374c.095 0 .158-.017.158-.1v-2.966c0-.086-.063-.1-.158-.1h-2.45v-1.881h2.649a1.665 1.665 0 0 1 1.629 1.412c.105.413.336 1.757.494 2.187.157.483.8 1.447 1.482 1.447h4.323a10 10 0 0 1-.949 1.1Zm4.65-7.821a10.3 10.3 0 0 1 .022 1.779h-1.051c-.105 0-.148.069-.148.172v.483c0 1.136-.641 1.384-1.2 1.447-.535.06-1.128-.224-1.2-.551a3.62 3.62 0 0 0-1.671-2.808c1.03-.654 2.1-1.619 2.1-2.911A3.29 3.29 0 0 0 21.44 9.8a4.56 4.56 0 0 0-2.2-.724H8.367A10.25 10.25 0 0 1 14.1 5.84l1.282 1.344a.76.76 0 0 0 1.072.026l1.434-1.372a10.25 10.25 0 0 1 7.015 5l-.982 2.217a.76.76 0 0 0 .386 1Zm2.448.036-.033-.343 1.011-.943a.42.42 0 0 0-.013-.595.4.4 0 0 0-.121-.081l-1.288-.483-.1-.334.806-1.12a.42.42 0 0 0-.13-.581.4.4 0 0 0-.133-.055l-1.363-.222-.164-.306.573-1.257a.42.42 0 0 0-.236-.544.4.4 0 0 0-.146-.029l-1.383.048-.224-.264.318-1.347a.42.42 0 0 0-.343-.487.4.4 0 0 0-.144 0l-1.348.315-.266-.219.049-1.381a.42.42 0 0 0-.431-.411.4.4 0 0 0-.141.028l-1.257.573-.306-.164-.222-1.363a.42.42 0 0 0-.5-.318.4.4 0 0 0-.133.055l-1.121.806-.333-.1-.483-1.293a.42.42 0 0 0-.555-.215.4.4 0 0 0-.12.08l-.946 1.012-.343-.033-.728-1.177a.42.42 0 0 0-.688 0l-.728 1.177-.343.033-.943-1.012a.42.42 0 0 0-.595.015.4.4 0 0 0-.08.12L12.483 3.8l-.333.1-1.12-.8a.42.42 0 0 0-.581.13.4.4 0 0 0-.055.133l-.222 1.363-.306.164-1.258-.573a.42.42 0 0 0-.544.239.4.4 0 0 0-.028.144l.048 1.383-.266.217-1.347-.316a.42.42 0 0 0-.487.343.4.4 0 0 0 0 .144L6.3 7.819l-.218.265L4.7 8.036a.422.422 0 0 0-.383.573l.573 1.257-.164.306-1.363.222a.42.42 0 0 0-.318.5.4.4 0 0 0 .055.133l.806 1.12-.1.334-1.293.483a.42.42 0 0 0-.215.555.4.4 0 0 0 .081.121l1.011.943-.033.343-1.177.728a.42.42 0 0 0 0 .688l1.177.728.033.343-1.011.943a.42.42 0 0 0 .015.595.4.4 0 0 0 .119.08l1.293.483.1.334-.806 1.124a.42.42 0 0 0 .131.581.4.4 0 0 0 .133.055l1.363.222.164.307-.573 1.257a.42.42 0 0 0 .24.545.4.4 0 0 0 .143.028l1.383-.048.219.266-.317 1.348a.42.42 0 0 0 .341.486.4.4 0 0 0 .146 0l1.345-.319.266.218-.049 1.382a.42.42 0 0 0 .429.41.4.4 0 0 0 .143-.028l1.257-.573.306.164.222 1.362a.42.42 0 0 0 .5.319.4.4 0 0 0 .133-.055l1.12-.807.334.1.483 1.292a.42.42 0 0 0 .556.214.4.4 0 0 0 .119-.08l.943-1.011.343.034.728 1.177a.42.42 0 0 0 .588.1.4.4 0 0 0 .1-.1l.728-1.177.343-.034.943 1.011a.42.42 0 0 0 .595-.015.4.4 0 0 0 .08-.119l.483-1.292.334-.1 1.12.807a.42.42 0 0 0 .581-.131.4.4 0 0 0 .055-.133l.222-1.362.306-.164 1.257.573a.42.42 0 0 0 .544-.239.4.4 0 0 0 .028-.143l-.048-1.384.265-.218 1.347.317a.42.42 0 0 0 .487-.34.5.5 0 0 0 0-.146l-.309-1.346.218-.266 1.383.048a.42.42 0 0 0 .41-.431.4.4 0 0 0-.028-.142l-.573-1.257.164-.307 1.363-.222a.42.42 0 0 0 .319-.5.4.4 0 0 0-.056-.135l-.806-1.12.1-.334 1.293-.483a.42.42 0 0 0 .215-.554.4.4 0 0 0-.081-.121l-1.011-.943.033-.343 1.177-.728a.42.42 0 0 0 0-.688Z"/></svg>',
    cpp: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#984c93" d="M14.742 24.047a10.24 10.24 0 0 1-4.673.919 7.63 7.63 0 0 1-5.914-2.346A8.88 8.88 0 0 1 2 16.369a9.48 9.48 0 0 1 2.422-6.748 8.22 8.22 0 0 1 6.285-2.588 11.2 11.2 0 0 1 4.035.641v3.761A6.84 6.84 0 0 0 11 10.395a4.81 4.81 0 0 0-3.712 1.535 5.9 5.9 0 0 0-1.413 4.159A5.8 5.8 0 0 0 7.209 20.1a4.57 4.57 0 0 0 3.59 1.493 7.3 7.3 0 0 0 3.943-1.113Zm2.37-9.218v-2.344h2.344v2.344H21.8v2.343h-2.344v2.343h-2.344v-2.343H14.77v-2.344zm8.201 0v-2.344h2.344v2.344H30v2.343h-2.343v2.343h-2.344v-2.343h-2.342v-2.344z"/></svg>',
    csharp: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#368832" d="M19.792 7.071h2.553v2.553H24.9V7.071h2.552v2.553H30v2.552h-2.55v2.551H30v2.553h-2.551v2.552H24.9v-2.55h-2.55v2.552h-2.557v-2.55H17.24v-2.559h2.553v-2.546H17.24V9.622h2.554Zm2.553 7.658H24.9v-2.553h-2.555Zm-7.656 9.284a10.2 10.2 0 0 1-4.653.915 7.6 7.6 0 0 1-5.89-2.336A8.84 8.84 0 0 1 2 16.367a9.44 9.44 0 0 1 2.412-6.719 8.18 8.18 0 0 1 6.259-2.577 11.1 11.1 0 0 1 4.018.638v3.745a6.8 6.8 0 0 0-3.723-1.036 4.8 4.8 0 0 0-3.7 1.529 5.88 5.88 0 0 0-1.407 4.142 5.77 5.77 0 0 0 1.328 3.992 4.55 4.55 0 0 0 3.575 1.487 7.3 7.3 0 0 0 3.927-1.108Z"/></svg>',
    docker: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#3a4e55" d="M18.191 13.071H20.7v2.566h1.27a5.5 5.5 0 0 0 1.744-.292 4.5 4.5 0 0 0 .848-.383 3.15 3.15 0 0 1-.589-1.623 3.43 3.43 0 0 1 .616-2.416l.264-.305.314.253a4 4 0 0 1 1.575 2.538 3.84 3.84 0 0 1 2.913.271l.345.2-.181.354a3.63 3.63 0 0 1-3.648 1.74c-2.173 5.413-6.9 7.976-12.642 7.976A7.96 7.96 0 0 1 6.3 20.211l-.025-.043-.226-.459a7.3 7.3 0 0 1-.579-3.693l.035-.38h2.143v-2.565h2.51v-2.51h5.02v-2.51h3.012v5.02Z"/><path fill="#00aada" d="M26.324 14.021a3.31 3.31 0 0 0-1.418-2.821 3.07 3.07 0 0 0 .289 3.821 5.28 5.28 0 0 1-3.225 1.037H5.883a6.8 6.8 0 0 0 .667 3.737l.183.335a6 6 0 0 0 .379.569q.992.064 1.829.045a9 9 0 0 0 2.669-.389.193.193 0 1 1 .126.365q-.135.047-.281.088a8.4 8.4 0 0 1-1.845.3c.044 0-.046.007-.046.007l-.082.007a22 22 0 0 1-2.008-.006l-.01.007a7.88 7.88 0 0 0 6.063 2.41c5.56 0 10.276-2.465 12.365-8 1.482.152 2.906-.226 3.553-1.49a3.5 3.5 0 0 0-3.122-.022"/><path fill="#27b9ec" d="M26.324 14.021a3.31 3.31 0 0 0-1.418-2.821 3.07 3.07 0 0 0 .289 3.821 5.28 5.28 0 0 1-3.225 1.037H6.836a5.22 5.22 0 0 0 2.106 4.686 9 9 0 0 0 2.669-.389.193.193 0 1 1 .126.365q-.135.047-.281.088a9 9 0 0 1-1.894.314l-.019-.022c1.892.971 4.636.967 7.782-.241a21.87 21.87 0 0 0 9.1-6.889l-.1.048"/><path fill="#088cb9" d="M5.913 17.732a6.4 6.4 0 0 0 .637 2.061l.183.335a6 6 0 0 0 .379.569q.992.064 1.829.045a9 9 0 0 0 2.669-.389.193.193 0 1 1 .126.365q-.135.047-.281.088a8.8 8.8 0 0 1-1.891.307h-.1q-.438.025-.922.026c-.351 0-.709-.007-1.1-.026a7.9 7.9 0 0 0 6.076 2.413c4.76 0 8.9-1.807 11.3-5.8Z"/><path fill="#039cc7" d="M6.98 17.732a4.83 4.83 0 0 0 1.961 3.01 9 9 0 0 0 2.669-.389.193.193 0 1 1 .126.365q-.135.047-.281.088a9 9 0 0 1-1.9.307c1.892.971 4.628.957 7.773-.252a20.6 20.6 0 0 0 5.377-3.13Z"/><path fill="#00acd3" d="M9.889 13.671h.172v1.813h-.172zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813H9.23v-1.813Zm-.33 0h.179v1.813H8.9v-1.813Zm-.33 0h.179v1.813H8.57zm-.323 0h.172v1.813h-.17v-1.813Zm-.181-.181h2.175v2.176H8.066V13.49Zm4.335-2.329h.172v1.813H12.4zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813h-.179zm-.33 0h.178v1.813h-.178zm-.323 0h.172v1.813h-.172zm-.181-.181h2.176v2.176h-2.175z"/><path fill="#26c2ee" d="M12.4 13.671h.172v1.813H12.4zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813h-.179zm-.33 0h.178v1.813h-.178zm-.323 0h.172v1.813h-.172zm-.181-.181h2.176v2.176h-2.175z"/><path fill="#00acd3" d="M14.909 13.671h.172v1.813h-.172zm-.33 0h.179v1.813h-.178zm-.33 0h.179v1.813h-.178zm-.33 0h.181v1.813h-.179v-1.813Zm-.33 0h.179v1.813h-.179zm-.323 0h.172v1.813h-.172zm-.181-.181h2.176v2.176h-2.174V13.49Z"/><path fill="#26c2ee" d="M14.909 11.161h.172v1.813h-.172zm-.33 0h.179v1.813h-.178zm-.33 0h.179v1.813h-.178zm-.33 0h.181v1.813h-.179v-1.813Zm-.33 0h.179v1.813h-.179zm-.323 0h.172v1.813h-.172zm-.181-.181h2.176v2.176h-2.174v-2.177Zm4.335 2.691h.172v1.813h-.172zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813H16.1zm-.323 0h.172v1.813h-.172zm-.177-.181h2.176v2.176H15.6z"/><path fill="#00acd3" d="M17.42 11.161h.172v1.813h-.172zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813H16.1zm-.323 0h.172v1.813h-.172zm-.181-.181h2.176v2.176H15.6v-2.177Z"/><path fill="#26c2ee" d="M17.42 8.65h.172v1.813h-.172zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813H16.1zm-.323 0h.172v1.813h-.172zm-.177-.181h2.176v2.176H15.6z"/><path fill="#00acd3" d="M19.93 13.671h.17v1.813h-.17zm-.33 0h.178v1.813H19.6zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813h-.179zm-.33 0h.179v1.813h-.179zm-.323 0h.172v1.813h-.172zm-.181-.181h2.176v2.176h-2.175z"/><path fill="#d5eef2" d="M12.616 19.193a.6.6 0 1 1-.6.6.6.6 0 0 1 .6-.6"/><path fill="#3a4e55" d="M12.616 19.363a.4.4 0 0 1 .156.029.175.175 0 1 0 .241.236.43.43 0 1 1-.4-.265M2 17.949h27.92c-.608-.154-1.923-.362-1.707-1.159-1.105 1.279-3.771.9-4.444.267-.749 1.087-5.111.674-5.415-.173-.939 1.1-3.85 1.1-4.789 0-.3.847-4.666 1.26-5.415.173-.673.631-3.338 1.012-4.444-.267.217.8-1.1 1.005-1.707 1.159"/><path fill="#c0dbe1" d="M14.211 23.518a5.3 5.3 0 0 1-2.756-2.711 9.2 9.2 0 0 1-1.987.3q-.436.024-.917.025-.554 0-1.168-.033a7.94 7.94 0 0 0 6.145 2.43q.344 0 .683-.013"/><path fill="#d5eef2" d="M12.007 21.773a5.2 5.2 0 0 1-.552-.966 9.2 9.2 0 0 1-1.987.3 6.3 6.3 0 0 0 2.539.664"/></svg>',
    cmake: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="a" x1="9.955" x2="16.68" y1="9.096" y2="23.324" gradientTransform="matrix(1 0 0 -1 0 32)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1011a1"/><stop offset="1" stop-color="#6969e1"/></linearGradient><linearGradient id="b" x1="16.231" x2="25.618" y1="19.655" y2="3.782" gradientTransform="matrix(1 0 0 -1 0 32)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#b40e0e"/><stop offset="1" stop-color="#ff5959"/></linearGradient><linearGradient id="c" x1="21.663" x2="8.381" y1="4.823" y2="5.938" gradientTransform="matrix(1 0 0 -1 0 32)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#01a300"/><stop offset="1" stop-color="#01df00"/></linearGradient><linearGradient id="d" x1="14.643" x2="14.472" y1="8.368" y2="14.145" gradientTransform="matrix(1 0 0 -1 0 32)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#848484"/><stop offset="1" stop-color="#d2d2d2"/></linearGradient></defs><path fill="url(#a)" d="M17.257 16.919 2.246 29.749 15.994 2.283Z"/><path d="m2.262 29.768-.038-.03L16.012 2.193l.008.088 1.263 14.649-.01.008ZM15.977 2.374 2.324 29.649 17.23 16.908Z"/><path fill="url(#b)" d="M17.952 24.931 16 2.28l13.767 27.471Z"/><path d="m29.818 29.8-.061-.025-11.828-4.827v-.015L15.975 2.282l.047-.013Zm-11.842-4.887L29.715 29.7 16.036 2.408Z"/><path fill="url(#c)" d="m11.16 22.094 18.621 7.654H2.25Z"/><path d="M29.781 29.773H2.183l.051-.044 8.921-7.665.014.006 18.622 7.655Zm-27.464-.05h27.337l-18.489-7.6Z"/><path fill="url(#d)" d="m11.189 22.112 6.059-5.168.843 7.98Z"/><path d="m18.149 25-.077-.032-6.978-2.842 6.194-5.283.01.094Zm-6.865-2.9 6.748 2.749-.824-7.8Z"/><path d="M29.7 29.911H2.285a.22.22 0 0 1-.182-.088.22.22 0 0 1 .022-.2L15.864 2.187a.17.17 0 0 1 .14-.1.15.15 0 0 1 .13.085l13.733 27.435a.24.24 0 0 1 .02.226.21.21 0 0 1-.187.078m-27.468-.16.057.011h27.4l.073-.009a.2.2 0 0 0-.028-.077L16 2.248v.012L2.261 29.684a.3.3 0 0 0-.025.067Z"/></svg>',
    make: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#ef5350" d="m29.5 24.02-1.6-.92a4.4 4.4 0 0 0 .09-.9A1.3 1.3 0 0 0 28 22a5.6 5.6 0 0 0-.1-1.1l1.6-.92a.493.493 0 0 0 .18-.68l-1.5-2.6a.45.45 0 0 0-.18-.18V6.01a2.006 2.006 0 0 0-2-2H4a2.006 2.006 0 0 0-2 2V22a2.006 2.006 0 0 0 2 2h10.53l-.03.02a.493.493 0 0 0-.18.68l1.5 2.6a.493.493 0 0 0 .68.18l1.6-.92a5.9 5.9 0 0 0 1.9 1.09v1.85a.495.495 0 0 0 .5.5h3a.495.495 0 0 0 .5-.5v-1.85a5.9 5.9 0 0 0 1.9-1.09l1.6.92a.493.493 0 0 0 .68-.18l1.5-2.6a.493.493 0 0 0-.18-.68M24 22.01a1.99 1.99 0 0 1-.88 1.65l-.18.11a2.04 2.04 0 0 1-1.88 0l-.18-.11a1.99 1.99 0 0 1-.88-1.65V22a2 2 0 0 1 .88-1.66l.18-.11a2.04 2.04 0 0 1 1.88 0l.18.11A2 2 0 0 1 24 22Zm2-4.63-.1.06a5.9 5.9 0 0 0-1.9-1.09V14.5a.495.495 0 0 0-.5-.5h-3a.495.495 0 0 0-.5.5v1.85a5.9 5.9 0 0 0-1.9 1.09l-1.6-.92a.493.493 0 0 0-.68.18l-1.5 2.6a.493.493 0 0 0 .18.68l1.6.92A5.6 5.6 0 0 0 16 22v.01L4 22V10.01h22Z"/></svg>'
};

const EXTENSIONS = {
    json: 'json', jsonc: 'json', json5: 'json',
    jsonl: 'jsonl', ndjson: 'jsonl',
    yaml: 'yaml', yml: 'yaml',
    xml: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml',
    csv: 'csv', tsv: 'csv',
    toml: 'toml',
    ini: 'ini', cfg: 'ini', conf: 'ini',
    properties: 'properties',
    md: 'md', markdown: 'md', mdx: 'md',
    txt: 'text', text: 'text',
    log: 'log',
    patch: 'patch', diff: 'patch',
    png: 'image', jpg: 'image', jpeg: 'image', jfif: 'image', gif: 'image', bmp: 'image',
    webp: 'image', ico: 'image', tif: 'image', tiff: 'image', avif: 'image', heic: 'image',
    heif: 'image', psd: 'image', raw: 'image', cr2: 'image', nef: 'image', arw: 'image', dng: 'image',
    bin: 'binary', dat: 'binary', exe: 'binary', dll: 'binary', zip: 'binary', gz: 'binary',
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
    ts: 'ts', tsx: 'ts',
    html: 'html', htm: 'html',
    css: 'css', scss: 'css', less: 'css',
    py: 'py', pyw: 'py',
    sh: 'sh', bash: 'sh', zsh: 'sh',
    ps1: 'ps', psm1: 'ps',
    bat: 'bat', cmd: 'bat',
    sql: 'sql',
    go: 'go', mod: 'go', work: 'go', sum: 'go',
    java: 'java',
    kt: 'kotlin', kts: 'kotlin',
    lua: 'lua',
    php: 'php', php3: 'php', php4: 'php', php5: 'php', phtml: 'php',
    rs: 'rust',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', 'h++': 'cpp', h: 'cpp',
    cs: 'csharp', csx: 'csharp',
    dockerfile: 'docker',
    mk: 'make',
    cmake: 'cmake',
};

const BASENAMES = {
    dockerfile: 'docker',
    makefile: 'make',
    gnumakefile: 'make',
    'cmakelists.txt': 'cmake',
};

// ===== 图标主题体系 =====
// 主题解析链：所选主题图标 → 文字缩写+底板（mono）→ 通用文件图标（plain）
// built-in: opensource（vscode-icons MIT）/ mono / plain；插件可通过 cadt.registerIconTheme 注册
let activeThemeId = 'opensource';
let pluginIconThemes = {};

export function setFileIconTheme(themeId, pluginThemes) {
    activeThemeId = themeId || 'opensource';
    pluginIconThemes = pluginThemes || {};
}

const PLAIN_FILE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.5L12.5 4.6V14.5H4z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>';

function themeIconFor(id) {
    if (activeThemeId === 'opensource') {
        if (OS_ICONS[id]) return OS_ICONS[id];
        if (OS_EXTRA_ICONS[id]) return OS_EXTRA_ICONS[id];
    }
    const pt = pluginIconThemes[activeThemeId];
    if (pt && pt.icons) {
        if (pt.icons[id]) return pt.icons[id];
        if (pt.icons['default_file']) return pt.icons['default_file'];
    }
    return null;
}

// vscode-icons 的 SVG 大量复用 id="a" / "b"，内联进同一文档后 url(#a) 会命中
// 先渲染图标的同名渐变；插入前把 id 与引用都改成实例内唯一。
let iconInstanceSeq = 0;
function scopeSvgIds(svg) {
    if (!svg || svg.indexOf('id="') < 0) return svg;
    const ids = [];
    const re = /\bid="([^"]+)"/g;
    let match;
    while ((match = re.exec(svg))) ids.push(match[1]);
    const prefix = 'fic' + (++iconInstanceSeq).toString(36) + '-';
    let out = svg;
    for (const id of ids) out = out.split('id="' + id + '"').join('id="' + prefix + id + '"');
    for (const id of ids) {
        out = out.split('url(#' + id + ')').join('url(#' + prefix + id + ')');
        out = out.split('href="#' + id + '"').join('href="#' + prefix + id + '"');
    }
    return out;
}

export function fileIconSpec(fileName) {
    const base = String(fileName || '').split(/[\\/]/).pop().toLowerCase();
    const dot = base.lastIndexOf('.');
    const ext = dot < 0 ? '' : base.slice(dot + 1);
    let id = BASENAMES[base] || EXTENSIONS[ext];
    if (!id && base.startsWith('dockerfile')) id = 'docker';
    if (!id) id = 'text';
    return {id, className: 'fi-' + id, svg: scopeSvgIds(ICONS[id])};
}

export function createFileIcon(fileName, extraClass) {
    const spec = fileIconSpec(fileName);
    const span = document.createElement('span');
    span.className = (extraClass ? extraClass + ' ' : '') + spec.className;
    span.dataset.fi = spec.id;
    let svg = null;
    if (activeThemeId === 'plain') {
        svg = PLAIN_FILE; // 纯净主题：文件一律通用纸页图标
    } else {
        svg = themeIconFor(spec.id) || ICONS[spec.id] || PLAIN_FILE;
    }
    span.innerHTML = scopeSvgIds(svg);
    return span;
}
