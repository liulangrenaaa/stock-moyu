const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const SHANGHAI_OFFSET = 8 * 60 * MINUTE;
const STALE_AFTER = 2 * MINUTE;
const MAX_TIMER_DELAY = 2147483647;

// 将腾讯行情时间按北京时间解析，并拒绝被日期自动进位掩盖的非法字段。
function parseQuoteTime(value) {
    if (typeof value !== 'string' || !/^\d{14}$/.test(value)) return null;
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
        + `T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}+08:00`;
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return null;
    const roundTrip = new Date(time + SHANGHAI_OFFSET).toISOString()
        .slice(0, 19).replace(/[-T:]/g, '');
    return roundTrip === value ? time : null;
}

// 固定显示北京时间，避免 Windows、WSL 与远端宿主时区不同造成误读。
function formatTime(time) {
    return new Date(time + SHANGHAI_OFFSET).toISOString()
        .slice(0, 19).replace('T', ' ');
}

// 按工作日交易窗口决定轮询与行情新鲜度基准，节假日由提示明确说明。
function getMarketState(now) {
    const local = new Date(now + SHANGHAI_OFFSET);
    const weekday = local.getUTCDay();
    const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(),
        local.getUTCDate()) - SHANGHAI_OFFSET;
    const minute = (now - dayStart) / MINUTE;
    const workday = weekday >= 1 && weekday <= 5;
    const active = workday && (
        (minute >= 555 && minute < 690) || (minute >= 780 && minute < 905)
    );
    const daysSinceClose = weekday === 0 ? 2 : weekday === 1 ? 3 : 1;
    let referenceTime = dayStart - daysSinceClose * DAY + 900 * MINUTE;
    if (workday && minute >= 570) {
        referenceTime = Math.min(now, dayStart + (minute < 780 ? 690 : 900) * MINUTE);
    }
    let nextOpenAt;
    for (let offset = 0; offset <= 7; offset += 1) {
        const day = (weekday + offset) % 7;
        if (day === 0 || day === 6) continue;
        for (const start of [555, 780]) {
            const candidate = dayStart + offset * DAY + start * MINUTE;
            if (candidate > now) {
                nextOpenAt = candidate;
                break;
            }
        }
        if (nextOpenAt !== undefined) break;
    }
    return { active, referenceTime, nextOpenAt };
}

// 标记缺失、超前或较旧的行情时间，午休和收盘后以最近收盘点作为基准。
function getQuoteWarning(quote, now) {
    if (!Number.isFinite(quote.quoteTime)) return '接口未提供有效行情时间';
    if (quote.quoteTime > now + STALE_AFTER) return '行情时间超前，请检查本机时间';
    if (getMarketState(now).referenceTime - quote.quoteTime > STALE_AFTER) {
        return '行情时间较旧，可能延迟、休市或停牌';
    }
    return '';
}

// 支持 Retry-After 的秒数与 HTTP 日期，异常值忽略且极大值不会溢出为快速重试。
function parseRetryAfter(value, now = Date.now()) {
    if (typeof value !== 'string' || !value.trim()) return 0;
    const text = value.trim();
    if (/^\d+$/.test(text)) {
        return Math.min(Number(text) * 1000, 8640000000000000 - now);
    }
    if (!/^[A-Za-z]/.test(text)) return 0;
    const time = Date.parse(text);
    return Number.isFinite(time) ? Math.max(0, time - now) : 0;
}

// 休市至少间隔一分钟，失败指数退避至五分钟，并遵守服务端要求的最短等待。
function getRefreshDelay(interval, now, {
    failures = 0, retryAfterMs = 0, statusCode
} = {}) {
    const market = getMarketState(now);
    const normal = market.active ? interval
        : Math.min(Math.max(interval, MINUTE), market.nextOpenAt - now);
    if (failures === 0) return normal;
    const backoff = Math.min(300000, Math.max(interval, 5000)
        * 2 ** Math.min(failures - 1, 16));
    return Math.max(normal, interval, backoff,
        statusCode === 429 ? 30000 : 0,
        Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
}

module.exports = {
    MAX_TIMER_DELAY,
    parseQuoteTime,
    formatTime,
    getMarketState,
    getQuoteWarning,
    parseRetryAfter,
    getRefreshDelay
};
