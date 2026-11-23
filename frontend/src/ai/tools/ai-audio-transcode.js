// ai-audio-transcode.js：ASR 前置转码——WebAudio 解码 + 16 kHz 单声道 + 纯 JS WAV 编码。
// 只依赖 WebView2 内置的 WebAudio（零新依赖）；整段音频进内存，校验 20 MB / 15 分钟上限。
export const AUDIO_TRANSCODE_MAX_BYTES = 20 * 1024 * 1024;
export const AUDIO_TRANSCODE_MAX_SECONDS = 15 * 60;
export const AUDIO_TRANSCODE_SAMPLE_RATE = 16000;
export const AUDIO_DIRECT_EXTENSIONS = ['wav', 'ogg', 'opus'];

// isDirectAsrPath：DeepSeek ASR 直接接受 WAV / Ogg Opus，其余扩展名先转码。
export function isDirectAsrPath(path) {
    const name = String(path || '').toLowerCase();
    const dot = name.lastIndexOf('.');
    if (dot < 0) return false;
    return AUDIO_DIRECT_EXTENSIONS.includes(name.slice(dot + 1));
}

// encodeWav16：Float32 声道数据 → 16 位 PCM WAV（RIFF）。channels 可为单条 Float32Array
// 或数组（多声道按帧交错）；音量裁剪在 [-1, 1]。
export function encodeWav16(channelData, sampleRate) {
    const channels = Array.isArray(channelData) ? channelData : [channelData];
    if (!channels.length || !channels[0] || !channels[0].length) {
        throw new Error('没有可编码的音频数据');
    }
    const numChannels = channels.length;
    const frames = channels[0].length;
    for (const channel of channels) {
        if (!channel || channel.length !== frames) throw new Error('各声道采样数不一致');
    }
    const dataSize = frames * numChannels * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeString = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true);
    view.setUint16(32, numChannels * 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);
    let offset = 44;
    for (let frame = 0; frame < frames; frame++) {
        for (let channel = 0; channel < numChannels; channel++) {
            const sample = Math.max(-1, Math.min(1, channels[channel][frame] || 0));
            view.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
            offset += 2;
        }
    }
    return buffer;
}

// transcodeAudioToWav16k：data URL → 16 kHz 单声道 WAV 的 ArrayBuffer。
// 抛错文案面向用户（格式不支持 / 超时长）。
export async function transcodeAudioToWav16k(dataURL) {
    const text = String(dataURL || '');
    const comma = text.indexOf(',');
    if (comma < 0 || !text.startsWith('data:')) throw new Error('音频数据无效');
    const binary = atob(text.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.byteLength > AUDIO_TRANSCODE_MAX_BYTES) {
        throw new Error('音频超过 20 MB，请先裁剪后再试');
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('当前环境不支持 WebAudio 转码');
    const audioCtx = new AudioCtx();
    let decoded = null;
    try {
        decoded = await audioCtx.decodeAudioData(bytes.buffer);
    } catch (e) {
        throw new Error('音频解码失败（wma / ape 等格式不支持，请先转成 mp3 / m4a / wav）');
    } finally {
        try { await audioCtx.close(); } catch (e) { /* 关闭失败不影响已解码数据 */ }
    }
    if (decoded.duration > AUDIO_TRANSCODE_MAX_SECONDS) {
        throw new Error('音频时长超过 15 分钟，请先裁剪后再试');
    }
    const length = Math.max(1, Math.ceil(decoded.duration * AUDIO_TRANSCODE_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, length, AUDIO_TRANSCODE_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    return encodeWav16([rendered.getChannelData(0)], AUDIO_TRANSCODE_SAMPLE_RATE);
}

// arrayBufferToBase64：分块拼接，避免超长音频触发 String.fromCharCode 参数上限。
export function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}
