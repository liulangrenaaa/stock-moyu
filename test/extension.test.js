const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStockController } = require('../extension');

const SAMPLE = [{
    code: 'sh000001', name: '上证指数', price: '3587.83', changePercent: '0.09',
    quoteTime: Date.parse('2026-11-18T09:59:50+08:00')
}];

// 等待当前请求的异步回调完成，不触发真实轮询。
async function flush() {
    await Promise.resolve();
    await Promise.resolve();
}

// 提供可检查的 VS Code 界面、配置与虚拟计时器。
function createHarness() {
    const state = {
        now: Date.parse('2026-11-18T10:00:00+08:00'),
        settings: { stockCodes: ['sh000001'], updateInterval: 3000 },
        requests: [],
        timers: new Map(),
        output: [],
        listenerDisposed: 0,
        outputDisposed: 0
    };
    let nextTimer = 0;
    let listener;
    const item = {
        text: '', tooltip: '', visible: false, disposed: 0,
        // 记录状态栏显示状态。
        show() { this.visible = true; },
        // 记录停止后的可见状态。
        hide() { this.visible = false; },
        // 记录状态栏释放次数。
        dispose() { this.disposed += 1; }
    };
    const vscode = {
        StatusBarAlignment: { Left: 1 },
        window: {
            // 返回可观察的状态栏对象。
            createStatusBarItem() { return item; },
            // 收集错误日志并跟踪输出面板释放。
            createOutputChannel() {
                return {
                    // 记录错误文本。
                    appendLine(message) { state.output.push(message); },
                    // 记录输出面板释放次数。
                    dispose() { state.outputDisposed += 1; }
                };
            }
        },
        workspace: {
            // 限制读取范围，验证没有使用原版全局配置。
            getConfiguration(section) {
                assert.equal(section, 'stockMoyu');
                return {
                    // 返回当前配置或调用方指定的默认值。
                    get(key, fallback) { return state.settings[key] ?? fallback; }
                };
            },
            // 保留配置监听器，以便测试模拟动态修改。
            onDidChangeConfiguration(callback) {
                listener = callback;
                return {
                    // 记录监听器释放次数。
                    dispose() { state.listenerDisposed += 1; }
                };
            }
        }
    };
    const controller = createStockController(vscode, {
        // 固定北京时间，避免测试结果受真实时间和宿主时区影响。
        now() { return state.now; },
        // 允许请求在停止后仍完成，以检验过期回调隔离。
        fetchQuotes(codes, { signal }) {
            // 将完成权交给测试，精确控制异步请求顺序。
            return new Promise(function defer(resolve, reject) {
                state.requests.push({ codes, signal, resolve, reject });
            });
        },
        // 保存定时任务而不实际等待。
        setTimer(callback, delay) {
            const id = ++nextTimer;
            state.timers.set(id, { callback, delay });
            return id;
        },
        // 删除已停止会话的等待任务。
        clearTimer(id) { state.timers.delete(id); }
    });
    // 模拟指定配置变化事件。
    function changeConfiguration(section = 'stockMoyu') {
        listener({
            // 只报告对应命名空间发生变化。
            affectsConfiguration(value) { return value === section; }
        });
    }
    // 推进虚拟时钟并执行一次等待任务，同时模拟计时器自然移除。
    function runTimer() {
        const [id, timer] = state.timers.entries().next().value;
        state.timers.delete(id);
        state.now += timer.delay;
        timer.callback();
    }
    return { state, item, controller, changeConfiguration, runTimer };
}

// 首次开启应立即请求，重复开启不产生额外任务。
test('重复开启幂等，慢请求期间不安排下一轮', async function testStart() {
    const { controller, state, item } = createHarness();
    controller.start();
    controller.start();
    assert.equal(state.requests.length, 1);
    assert.equal(state.timers.size, 0);
    assert.equal(item.visible, true);
    state.requests[0].resolve(SAMPLE);
    await flush();
    assert.equal(state.timers.size, 1);
    assert.match(item.text, /上证指数/);
    controller.dispose();
});

// 每轮结束后只留下一个下一轮任务。
test('连续轮询不重叠', async function testPolling() {
    const { controller, state, runTimer } = createHarness();
    controller.start();
    state.requests[0].resolve(SAMPLE);
    await flush();
    assert.equal([...state.timers.values()][0].delay, 3000);
    runTimer();
    assert.equal(state.requests.length, 2);
    assert.equal(state.timers.size, 0);
    state.requests[1].resolve(SAMPLE);
    await flush();
    assert.equal(state.timers.size, 1);
    controller.dispose();
});

// 覆盖原版停止后异步回调继续更新界面的问题。
test('停止会取消在途请求并忽略迟到结果', async function testStopPending() {
    const { controller, state, item } = createHarness();
    controller.start();
    const loadingText = item.text;
    controller.stop();
    assert.equal(state.requests[0].signal.aborted, true);
    state.requests[0].resolve(SAMPLE);
    await flush();
    assert.equal(item.visible, false);
    assert.equal(item.text, loadingText);
    assert.equal(state.timers.size, 0);
    controller.dispose();
});

// 停止等待中的会话后不能继续发出请求。
test('停止会清理待执行任务', async function testStopTimer() {
    const { controller, state } = createHarness();
    controller.start();
    state.requests[0].resolve(SAMPLE);
    await flush();
    controller.stop();
    assert.equal(state.timers.size, 0);
    controller.dispose();
});

// 新会话必须不受旧会话成功或失败结果影响。
test('停止后重开不受旧请求覆盖', async function testRestartRace() {
    const { controller, state, item } = createHarness();
    controller.start();
    controller.stop();
    controller.start();
    state.requests[1].resolve(SAMPLE);
    await flush();
    const currentText = item.text;
    state.requests[0].reject(new Error('旧请求错误'));
    await flush();
    assert.equal(item.text, currentText);
    assert.deepEqual(state.output, []);
    assert.equal(state.timers.size, 1);
    controller.dispose();
});

// 配置变更时立即应用新代码和间隔，旧请求不再有写入权。
test('配置变更中断旧请求并立即生效', async function testConfiguration() {
    const { controller, state, item, changeConfiguration } = createHarness();
    controller.start();
    state.settings.stockCodes = ['sz002649'];
    state.settings.updateInterval = 5000;
    changeConfiguration();
    assert.equal(state.requests[0].signal.aborted, true);
    assert.deepEqual(state.requests[1].codes, ['sz002649']);
    state.requests[1].resolve([{
        code: 'sz002649', name: '博彦科技', price: '8.91', changePercent: '-0.50',
        quoteTime: SAMPLE[0].quoteTime
    }]);
    await flush();
    state.requests[0].resolve(SAMPLE);
    await flush();
    assert.match(item.text, /博彦科技/);
    assert.doesNotMatch(item.text, /上证指数/);
    assert.equal(state.timers.size, 1);
    assert.equal([...state.timers.values()][0].delay, 5000);
    controller.dispose();
});

// 其他插件配置变化和停用期间的配置变化均不应启动请求。
test('无关配置及停止状态不会自动开启行情', function testUnrelatedConfig() {
    const { controller, state, changeConfiguration } = createHarness();
    changeConfiguration();
    assert.equal(state.requests.length, 0);
    controller.start();
    changeConfiguration('editor');
    assert.equal(state.requests.length, 1);
    controller.dispose();
});

// 失败时保留旧行情并明确标记过期，随后能够恢复。
test('网络失败标记旧行情并在恢复后清除警告', async function testRecovery() {
    const { controller, state, item, runTimer } = createHarness();
    controller.start();
    state.requests[0].resolve(SAMPLE);
    await flush();
    runTimer();
    state.requests[1].reject(new Error('行情请求超时。'));
    await flush();
    assert.match(item.text, /warning.*上证指数/);
    assert.match(item.tooltip, /上次成功/);
    assert.equal(state.timers.size, 1);
    runTimer();
    state.requests[2].resolve(SAMPLE);
    await flush();
    assert.doesNotMatch(item.text, /warning/);
    assert.doesNotMatch(item.tooltip, /上次成功/);
    controller.dispose();
});

// 初次失败不应永久停留在加载中。
test('初次请求失败显示错误并自动安排重试', async function testInitialFailure() {
    const { controller, state, item } = createHarness();
    controller.start();
    state.requests[0].reject(new Error('接口错误'));
    await flush();
    assert.match(item.text, /行情暂不可用/);
    assert.match(item.tooltip, /接口错误/);
    assert.equal(state.timers.size, 1);
    controller.dispose();
});

// 持续断网时不应反复写入相同错误日志。
test('重复错误日志去重', async function testRepeatedError() {
    const { controller, state, runTimer } = createHarness();
    controller.start();
    state.requests[0].reject(new Error('断网'));
    await flush();
    runTimer();
    state.requests[1].reject(new Error('断网'));
    await flush();
    assert.deepEqual(state.output, ['断网']);
    controller.dispose();
});

// 错误配置不发请求，同时允许用户在运行中修正。
test('无效配置可通过设置变更恢复', async function testInvalidConfiguration() {
    const { controller, state, item, changeConfiguration } = createHarness();
    state.settings.stockCodes = [];
    controller.start();
    await flush();
    assert.equal(state.requests.length, 0);
    assert.match(item.tooltip, /有效股票代码/);
    state.settings.stockCodes = ['sh000001'];
    changeConfiguration();
    assert.equal(state.requests.length, 1);
    state.requests[0].resolve(SAMPLE);
    await flush();
    assert.match(item.text, /上证指数/);
    controller.dispose();
});

// 部分失败不能悄悄隐藏用户配置的其他代码。
test('缺失代码在悬浮提示中标记', async function testMissingCodes() {
    const { controller, state, item } = createHarness();
    state.settings.stockCodes = ['sh000001', 'sz002649'];
    controller.start();
    state.requests[0].resolve(SAMPLE);
    await flush();
    assert.match(item.text, /warning/);
    assert.match(item.tooltip, /未返回有效行情：sz002649/);
    controller.dispose();
});

// 停用、订阅清理重复调用时资源只释放一次。
test('释放清理所有资源且不可再次启动', async function testDispose() {
    const { controller, state, item } = createHarness();
    controller.start();
    controller.dispose();
    controller.dispose();
    controller.start();
    state.requests[0].resolve(SAMPLE);
    await flush();
    assert.equal(state.requests[0].signal.aborted, true);
    assert.equal(state.requests.length, 1);
    assert.equal(state.timers.size, 0);
    assert.equal(item.visible, false);
    assert.equal(item.disposed, 1);
    assert.equal(state.listenerDisposed, 1);
    assert.equal(state.outputDisposed, 1);
});

// 获取成功也必须揭示行情本身过期，而不是把本地获取时间当作更新时间。
test('旧行情标记警告并分别显示行情时间与获取时间', async function testStaleSnapshot() {
    const { controller, state, item } = createHarness();
    controller.start();
    state.requests[0].resolve([{ ...SAMPLE[0],
        quoteTime: Date.parse('2026-11-17T15:00:00+08:00') }]);
    await flush();
    assert.match(item.text, /warning/);
    assert.match(item.tooltip, /获取时间（北京时间）：2026-11-18 10:00:00/);
    assert.match(item.tooltip, /行情时间：2026-11-17 15:00:00/);
    assert.match(item.tooltip, /行情时间较旧/);
    controller.dispose();
});

// 接口时间缺失时不能凭成功请求伪造数据新鲜度。
test('缺失行情时间显示未知并提示', async function testUnknownTimestamp() {
    const { controller, state, item } = createHarness();
    controller.start();
    state.requests[0].resolve([{ ...SAMPLE[0], quoteTime: null }]);
    await flush();
    assert.match(item.text, /warning/);
    assert.match(item.tooltip, /行情时间：未知.*未提供有效行情时间/);
    controller.dispose();
});

// 收盘后的当天快照保持正常显示，但轮询不再每三秒触发。
test('收盘快照不误报过期且休市降频', async function testClosedMarket() {
    const { controller, state, item } = createHarness();
    state.now = Date.parse('2026-11-18T16:41:46+08:00');
    controller.start();
    state.requests[0].resolve([{ ...SAMPLE[0],
        quoteTime: Date.parse('2026-11-18T16:15:00+08:00') }]);
    await flush();
    assert.doesNotMatch(item.text, /warning/);
    assert.match(item.tooltip, /非交易时段/);
    assert.equal([...state.timers.values()][0].delay, 60000);
    controller.dispose();
});

// 重试逐次延长且恢复成功后下一次失败从初始退避重新开始。
test('连续失败指数退避并在成功后重置', async function testBackoffReset() {
    const { controller, state, item, runTimer } = createHarness();
    controller.start();
    for (const delay of [5000, 10000, 20000]) {
        state.requests.at(-1).reject(new Error('断网'));
        await flush();
        assert.equal([...state.timers.values()][0].delay, delay);
        assert.match(item.tooltip, new RegExp(`失败重试：${delay / 1000} 秒后`));
        runTimer();
    }
    state.requests.at(-1).resolve([{ ...SAMPLE[0], quoteTime: state.now }]);
    await flush();
    assert.equal([...state.timers.values()][0].delay, 3000);
    runTimer();
    state.requests.at(-1).reject(new Error('再次断网'));
    await flush();
    assert.equal([...state.timers.values()][0].delay, 5000);
    assert.match(item.tooltip, /行情时间：2026-11-18 10:00:35/);
    controller.dispose();
});

// 服务端指定的等待时间必须覆盖常规刷新间隔并可被停止命令取消。
test('限流按服务端要求等待且停止清理计时器', async function testRateLimit() {
    const { controller, state, item, runTimer } = createHarness();
    controller.start();
    const error = Object.assign(new Error('HTTP 429'), {
        statusCode: 429, retryAfterMs: 120000
    });
    state.requests[0].reject(error);
    await flush();
    assert.equal([...state.timers.values()][0].delay, 120000);
    assert.match(item.tooltip, /失败重试：120 秒后/);
    runTimer();
    state.requests[1].reject(error);
    await flush();
    controller.stop();
    assert.equal(state.timers.size, 0);
    controller.dispose();
});

// 极大 Retry-After 分段等待，避免 Node.js 将溢出时限变成一毫秒。
test('超长限流分段计时且不到期限不发请求', async function testLongRetry() {
    const { controller, state, runTimer } = createHarness();
    controller.start();
    state.requests[0].reject(Object.assign(new Error('限流'), {
        statusCode: 429, retryAfterMs: 2147483647 + 10000
    }));
    await flush();
    assert.equal([...state.timers.values()][0].delay, 2147483647);
    runTimer();
    assert.equal(state.requests.length, 1);
    assert.equal([...state.timers.values()][0].delay, 10000);
    runTimer();
    assert.equal(state.requests.length, 2);
    controller.dispose();
});

// 被清除但已经排队的旧计时器不能覆盖新会话的计时器引用。
test('重启后迟到的旧计时器不干扰新会话清理', async function testLateTimer() {
    const { controller, state } = createHarness();
    controller.start();
    state.requests[0].resolve(SAMPLE);
    await flush();
    const oldTimer = [...state.timers.values()][0];
    controller.stop();
    controller.start();
    state.requests[1].resolve(SAMPLE);
    await flush();
    oldTimer.callback();
    assert.equal(state.requests.length, 2);
    controller.stop();
    assert.equal(state.timers.size, 0);
    controller.dispose();
});
