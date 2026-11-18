const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
    normalizeStockCodes,
    normalizeInterval,
    parseQuotes,
    formatQuotes,
    requestQuotes
} = require('../getStock');

// 构造与真实接口字段位置一致的行情记录。
function record(code = 'sh000001', {
    name = '上证指数', price = '3587.83', percent = '0.09'
} = {}) {
    const fields = Array(33).fill('');
    fields[0] = '1';
    fields[1] = name;
    fields[2] = code.slice(2);
    fields[3] = price;
    fields[32] = percent;
    return `v_${code}="${fields.join('~')}";`;
}

// 用可控流模拟网络事件，避免测试依赖公网行情与真实交易时间。
function createTransport({
    body = Buffer.from(record()),
    status = 200,
    contentType = 'text/plain; charset=utf-8',
    requestError,
    interrupted = false,
    stalled = false
} = {}) {
    const state = { destroyed: false };
    const transport = {
        // 保留 HTTPS 调用参数，并在监听器安装后发送网络事件。
        get(url, options, onResponse) {
            state.url = url;
            state.options = options;
            const request = new EventEmitter();
            const response = new PassThrough();
            response.statusCode = status;
            response.headers = { 'content-type': contentType };
            // 模拟请求取消时对连接的清理。
            request.destroy = function destroy(error) {
                state.destroyed = true;
                response.destroy();
                if (error) request.emit('error', error);
                return request;
            };
            // 模拟原生 HTTPS 对 AbortSignal 的处理。
            function onAbort() {
                const error = new Error('请求已取消');
                error.name = 'AbortError';
                request.destroy(error);
            }
            // 流结束后清理测试用的取消监听器。
            response.on('close', function onClose() {
                options.signal?.removeEventListener('abort', onAbort);
            });
            // 延后返回响应，以符合 Node.js HTTP 的异步事件时序。
            queueMicrotask(function respond() {
                if (options.signal?.aborted) {
                    onAbort();
                    return;
                }
                options.signal?.addEventListener('abort', onAbort, { once: true });
                if (requestError) {
                    request.emit('error', requestError);
                    response.destroy();
                    return;
                }
                if (stalled) return;
                onResponse(response);
                if (interrupted) {
                    response.emit('aborted');
                    response.destroy();
                    return;
                }
                response.end(body);
            });
            return request;
        }
    };
    return { transport, state };
}

// 验证代码规范化、去重和常见中文分隔符。
test('代码支持数组、大小写及分隔字符串', function testCodes() {
    assert.deepEqual(normalizeStockCodes([' SH000001 ', 'sz002649', 'sh000001']),
        ['sh000001', 'sz002649']);
    assert.deepEqual(normalizeStockCodes('sh000001，sz002649 bj430047'),
        ['sh000001', 'sz002649', 'bj430047']);
});

// 防止错误配置构成无效或被注入的请求地址。
test('空配置、错误类型及参数注入被拒绝', function testInvalidCodes() {
    for (const value of ['', [], {}, [123], 'sh000001&x=1', '600519', 'hk00700']) {
        // 将待验证参数交给断言捕获同步校验错误。
        assert.throws(function normalizeInvalid() {
            normalizeStockCodes(value);
        });
    }
});

// 保持请求规模上限，同时允许重复配置被去重。
test('最多查询五十个不同代码', function testCodeLimit() {
    const codes = [];
    for (let i = 0; i < 51; i += 1) codes.push(`sh${String(i).padStart(6, '0')}`);
    // 超过上限时拒绝请求。
    assert.throws(function tooManyCodes() {
        normalizeStockCodes(codes);
    }, /50/);
    assert.equal(normalizeStockCodes(Array(100).fill('sh000001')).length, 1);
});

// 验证非法间隔不会退化成高频轮询。
test('刷新间隔有默认值和上下限', function testInterval() {
    for (const value of [undefined, null, '', 0, -1, NaN, Infinity, 'invalid']) {
        assert.equal(normalizeInterval(value), 3000);
    }
    assert.equal(normalizeInterval('3000'), 3000);
    assert.equal(normalizeInterval(100), 1000);
    assert.equal(normalizeInterval(1e9), 3600000);
});

// 按配置顺序返回有效记录，忽略接口额外返回的数据。
test('解析按代码匹配，保留顺序与零涨幅', function testParseOrder() {
    const body = record('sz002649', { name: '博彦科技', price: '8.91', percent: '0.00' })
        + record() + record('bj430047', { name: '其他' });
    const quotes = parseQuotes(body, ['sh000001', 'sz002649']);
    assert.deepEqual(quotes, [
        { code: 'sh000001', name: '上证指数', price: '3587.83', changePercent: '0.09' },
        { code: 'sz002649', name: '博彦科技', price: '8.91', changePercent: '0.00' }
    ]);
});

// 覆盖原版永远不成立的空数组检查。
test('空响应、无效代码与损坏行情产生明确错误', function testInvalidBody() {
    const bodies = ['', 'v_pv_none_match="1";', 'v_sh000001="";',
        record('sh000001', { price: 'NaN' }),
        record('sh000001', { percent: '--' }),
        record('sh000001', { price: '-1' })];
    for (const body of bodies) {
        // 不允许无效行情变成空白状态栏。
        assert.throws(function parseInvalid() {
            parseQuotes(body, ['sh000001']);
        }, /有效行情/);
    }
});

// 单个代码损坏不影响其余代码继续显示。
test('部分代码无效时保留其余行情', function testPartialQuotes() {
    const quotes = parseQuotes(record(), ['sh000001', 'sz002649']);
    assert.equal(quotes.length, 1);
    assert.equal(quotes[0].code, 'sh000001');
});

// 正负涨幅和零值应清晰且不重复添加符号。
test('格式化保留价格精度并区分涨跌', function testFormat() {
    assert.equal(formatQuotes([
        { name: 'A', price: '8.90', changePercent: '1.20' },
        { name: 'B', price: '0.00', changePercent: '-2.30' },
        { name: 'C', price: '1.00', changePercent: '0.00' }
    ]), 'A: 8.90 +1.20%  |  B: 0.00 -2.30%  |  C: 1.00 0.00%');
});

// 使用明确的 GBK 字节验证中文名称不会乱码。
test('请求正确解码 GBK 中文', async function testGbk() {
    const parts = record('sh000001', { name: 'NAME' }).split('NAME');
    const body = Buffer.concat([
        Buffer.from(parts[0]),
        Buffer.from('c9cfd6a4d6b8cafd', 'hex'),
        Buffer.from(parts[1])
    ]);
    const { transport, state } = createTransport({
        body, contentType: 'text/html; charset=GBK'
    });
    const quotes = await requestQuotes(['sh000001'], { transport });
    assert.equal(quotes[0].name, '上证指数');
    assert.equal(state.url, 'https://qt.gtimg.cn/q=sh000001');
});

// 同时支持测试或代理明确标记为 UTF-8 的响应。
test('请求识别 UTF-8 字符集', async function testUtf8() {
    const { transport } = createTransport();
    const quotes = await requestQuotes(['sh000001'], { transport });
    assert.equal(quotes[0].name, '上证指数');
});

// 非成功状态不能被当成行情文本解析。
test('HTTP 错误被反馈给调用方', async function testHttpError() {
    const { transport, state } = createTransport({ status: 503 });
    await assert.rejects(requestQuotes(['sh000001'], { transport }), /503/);
    assert.equal(state.destroyed, true);
});

// 防止连接错误或响应中断使轮询永久挂起。
test('网络错误与中断都会结束请求', async function testNetworkFailure() {
    const failure = createTransport({ requestError: new Error('socket failed') });
    await assert.rejects(requestQuotes(['sh000001'], failure), /socket failed/);
    const interrupted = createTransport({ interrupted: true });
    await assert.rejects(requestQuotes(['sh000001'], interrupted), /中断/);
});

// 空响应应走重试逻辑，而不是显示空白。
test('请求层传递解析错误', async function testParseFailure() {
    const { transport } = createTransport({ body: Buffer.alloc(0) });
    await assert.rejects(requestQuotes(['sh000001'], { transport }), /有效行情/);
});

// 总时限到达后主动关闭停滞连接。
test('超时销毁底层请求', async function testTimeout() {
    const { transport, state } = createTransport({ stalled: true });
    await assert.rejects(requestQuotes(['sh000001'], { transport, timeoutMs: 10 }), /超时/);
    assert.equal(state.destroyed, true);
});

// 停止扩展时能够中断等待中的网络请求。
test('取消信号传递到底层 HTTPS 请求', async function testAbort() {
    const { transport, state } = createTransport({ stalled: true });
    const controller = new AbortController();
    const promise = requestQuotes(['sh000001'], { transport, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await assert.rejects(promise, { name: 'AbortError' });
    assert.equal(state.destroyed, true);
});

// 限制异常响应的内存占用。
test('超大响应中断连接', async function testLargeResponse() {
    const { transport, state } = createTransport({ body: Buffer.alloc(512 * 1024 + 1) });
    await assert.rejects(requestQuotes(['sh000001'], { transport }), /大小限制/);
    assert.equal(state.destroyed, true);
});

// 底层同步抛错也需要清除请求总时限。
test('同步网络异常转为拒绝结果', async function testSyncFailure() {
    const transport = {
        // 模拟底层 HTTPS 初始化失败。
        get() {
            throw new Error('initialization failed');
        }
    };
    await assert.rejects(requestQuotes(['sh000001'], { transport }), /initialization/);
});
