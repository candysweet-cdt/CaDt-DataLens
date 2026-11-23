// ai-layout-motion.js：AI 面板「布局高度变化」动效的纯判定层。
//
// 消息区（.ai-messages）靠 padding-bottom 给底部堆叠区（队列 / 任务卡 / 审批卡）让位，
// 堆叠区变矮时 padding 跟着缩小、贴底态要补底。直接硬切会看到面板瞬间「缩一截」。
// 这里只放可单测的判定：要不要补一段收缩动画、用多长、从多高收到多高。DOM/动画在调用方做。
//
// 约定（沿用项目现有动效量级，见 style.css 的 120–180ms 家族）：
// - 时长 180ms，ease；只动 opacity / height 这类可合成或局部布局属性；
// - 尊重系统 prefers-reduced-motion：减少动画时一律不播；
// - 高度差太小（≤1px）不播——避免噪声动画与无谓的逐帧补底。

export const LAYOUT_MOTION_MS = 180;
// 高度差不超过这个像素数就跳过动画：1px 的收缩肉眼不可见，只带来逐帧补底开销。
export const MIN_MOTION_DELTA_PX = 1;

// 是否要为一次「旧高度 → 新高度」的变化补收缩/展开动画。
// reduceMotion: boolean（来自 matchMedia('(prefers-reduced-motion: reduce)')）
// animateAvailable: boolean（运行时是否支持 Element.animate）
export function shouldAnimateLayout(oldHeight, newHeight, reduceMotion, animateAvailable) {
    if (reduceMotion || !animateAvailable) return false;
    const from = Number(oldHeight);
    const to = Number(newHeight);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
    return Math.abs(from - to) > MIN_MOTION_DELTA_PX;
}

// 生成 Web Animations 的高度补间关键帧。overflow:hidden 让收缩过程中溢出的子行不闪出容器。
export function heightKeyframes(oldHeight, newHeight) {
    return [
        {height: Math.round(oldHeight) + 'px', overflow: 'hidden'},
        {height: Math.round(newHeight) + 'px', overflow: 'hidden'},
    ];
}

export const LAYOUT_MOTION_OPTIONS = Object.freeze({duration: LAYOUT_MOTION_MS, easing: 'ease'});
