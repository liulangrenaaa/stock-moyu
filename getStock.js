const https = require('node:https');

const DEFAULT_CODES = ['sh000001', 'sz002649'];
const DEFAULT_INTERVAL = 3000;
const MAX_RESPONSE_BYTES = 512 * 1024;

// 统一并校验代码，避免空请求、重复查询和地址参数注入。
function normalizeStockCodes(value = DEFAULT_CODES) {
    const values = typeof value === 'string' ? value.split(/[,，;\s]+/) : value;
    if (!Array.isArray(values)) {
        throw new Error('股票代码必须是数组或以逗号分隔的字符串。');
    }
    const codes = [];
    for (const value of values) {
        if (typeof value !== 'string') {
            throw new Error('每个股票代码都必须是字符串。');
        }
        const code = value.trim().toLowerCase();
        if (!code) continue;
        if (!/^(sh|sz|bj)\d{6}$/.test(code)) {
            throw new Error(`股票代码格式无效：${code}`);
        }
        if (!codes.includes(code)) codes.push(code);
    }
    if (codes.length === 0 || codes.length > 50) {
        throw new Error('请设置 1 到 50 个有效股票代码。');
    }
    return codes;
}

// 对异常配置使用默认间隔，并限制轮询频率。
function normalizeInterval(value = DEFAULT_INTERVAL) {
    const interval = Number(value);
    if (!Number.isFinite(interval) || interval <= 0) return DEFAULT_INTERVAL;
    return Math.max(1000, Math.min(3600000, Math.round(interval)));
}

// 按代码匹配腾讯行情记录，并忽略缺失或损坏的数据。
function parseQuotes(body, codes) {
    const records = new Map();
    const numberPattern = /^[+-]?\d+(?:\.\d+)?$/;
    for (const match of body.matchAll(/\bv_([a-z0-9]+)="([^"]*)"\s*;/g)) {
        const fields = match[2].split('~');
        if (
            !fields[1] ||
            !numberPattern.test(fields[3] || '') ||
            !numberPattern.test(fields[32] || '') ||
            !Number.isFinite(Number(fields[3])) ||
            !Number.isFinite(Number(fields[32])) ||
            Number(fields[3]) < 0
        ) continue;
        records.set(match[1], {
            code: match[1],
            name: fields[1],
            price: fields[3],
            changePercent: fields[32]
        });
    }
    const quotes = [];
    for (const code of codes) {
        if (records.has(code)) quotes.push(records.get(code));
    }
    if (quotes.length === 0) {
        throw new Error('没有获取到有效行情，请检查股票代码或稍后重试。');
    }
    return quotes;
}

// 生成状态栏文字，明确标记正涨幅。
function formatQuotes(quotes) {
    const labels = [];
    for (const quote of quotes) {
        const percent = Number(quote.changePercent) > 0
            ? `+${quote.changePercent.replace(/^\+/, '')}`
            : quote.changePercent;
        labels.push(`${quote.name}: ${quote.price} ${percent}%`);
    }
    return labels.join('  |  ');
}

// 使用内置 HTTPS 获取行情，提供取消、总时限和响应体大小限制。
function requestQuotes(codes, { signal, timeoutMs = 10000, transport = https } = {}) {
    const normalizedCodes = normalizeStockCodes(codes);
    // 将底层流事件转换为单次结算的请求结果。
    return new Promise(function executeRequest(resolve, reject) {
        let request;
        let response;
        let settled = false;

        // 统一清理总时限，防止重复事件改变请求结果。
        function finish(error, quotes) {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            if (error) reject(error);
            else resolve(quotes);
        }

        // 到达总时限后终止连接，避免慢响应无限占用轮询。
        function onTimeout() {
            const error = new Error('行情请求超时。');
            finish(error);
            response?.destroy();
            request?.destroy();
        }

        const deadline = setTimeout(onTimeout, timeoutMs);

        // 检查状态码，收集响应并按接口字符集解码。
        function onResponse(incoming) {
            response = incoming;
            response.on('error', finish);
            // 中途断开也必须结束本次请求。
            response.on('aborted', function onAborted() {
                finish(new Error('行情响应中断。'));
            });
            if (settled) {
                response.destroy();
                return;
            }
            if (response.statusCode !== 200) {
                finish(new Error(`行情接口返回 HTTP ${response.statusCode}。`));
                response.destroy();
                request?.destroy();
                return;
            }
            const chunks = [];
            let size = 0;
            // 限制累计字节，防止异常响应持续占用内存。
            response.on('data', function onData(chunk) {
                if (settled) return;
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                size += bytes.length;
                if (size > MAX_RESPONSE_BYTES) {
                    finish(new Error('行情响应超过大小限制。'));
                    response.destroy();
                    request?.destroy();
                    return;
                }
                chunks.push(bytes);
            });
            // 完整接收后校验数据，解析失败通过错误状态反馈。
            response.on('end', function onEnd() {
                if (settled) return;
                try {
                    const contentType = response.headers['content-type'] || '';
                    const encoding = /charset\s*=\s*["']?utf-8/i.test(contentType)
                        ? 'utf-8'
                        : 'gb18030';
                    const body = new TextDecoder(encoding, { fatal: true })
                        .decode(Buffer.concat(chunks));
                    finish(null, parseQuotes(body, normalizedCodes));
                } catch (error) {
                    finish(error);
                }
            });
        }

        try {
            request = transport.get(
                `https://qt.gtimg.cn/q=${normalizedCodes.join(',')}`,
                { signal, headers: { 'User-Agent': 'stock-moyu/0.1.0' } },
                onResponse
            );
            request.on('error', finish);
        } catch (error) {
            finish(error);
        }
    });
}

module.exports = {
    DEFAULT_CODES,
    DEFAULT_INTERVAL,
    normalizeStockCodes,
    normalizeInterval,
    parseQuotes,
    formatQuotes,
    requestQuotes
};
