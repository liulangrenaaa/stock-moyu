const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createQuotePopup, buildPopupItems, formatStatusBar } = require('../quotePopup');
const { createQuickPickHarness } = require('../test-support/quickPickHarness');

const NOW = Date.parse('2026-11-18T10:00:00+08:00');
const QUOTES = [
    { code: 'sh000001', name: '上证指数', price: '3587.83', changePercent: '0.09', quoteTime: NOW },
    { code: 'sz002649', name: '博彦科技', price: '8.91', changePercent: '-0.50', quoteTime: NOW },
    { code: 'sh600519', name: '贵州茅台', price: '1400.00', changePercent: '0.00', quoteTime: NOW }
];

// 创建与真实控制器快照一致的列表状态。
function snapshot(extra = {}) {
    return {
        codes: ['sh000001', 'sz002649', 'sh600519'], quotes: QUOTES,
        busy: false, fetchedAt: NOW, error: '', nextRefreshAt: NOW + 3000, ...extra
    };
}

// 状态栏只占有限宽度，并显示未展开的股票数量。
test('状态栏按数量截断且保持价格精度', function testStatusBarLimit() {
    assert.equal(formatStatusBar(QUOTES, 3, 1), '上证指数: 3587.83 +0.09%  |  +2只');
    assert.equal(formatStatusBar(QUOTES, 3, 3),
        '上证指数: 3587.83 +0.09%  |  博彦科技: 8.91 -0.50%  |  贵州茅台: 1400.00 0.00%');
    assert.equal(formatStatusBar(QUOTES, 3, NaN), formatStatusBar(QUOTES, 3, 2));
});

// 行情代码可供原生搜索匹配，缺失和过期记录均不能被静默隐藏。
test('浮层保留顺序、代码、时间以及缺失行情', function testPopupRows() {
    const items = buildPopupItems(snapshot({
        codes: ['sz002649', 'sh000001', 'bj430047'],
        quotes: [QUOTES[0], { ...QUOTES[1], quoteTime: NOW - 300000 }]
    }), NOW);
    assert.deepEqual(items.map(
        // 比较每行股票身份，避免价格变化影响顺序断言。
        function code(item) { return item.code; }
    ), ['sz002649', 'sh000001', 'bj430047']);
    assert.match(items[0].label, /warning.*博彦科技.*-0.50%/);
    assert.equal(items[0].description, 'sz002649');
    assert.match(items[0].detail, /2026-11-18 09:55:00.*较旧/);
    assert.doesNotMatch(items[1].label, /warning/);
    assert.match(items[2].description, /暂无有效行情/);
});

// 失败后保留旧行情，但不能让浮层仍将其作为本次成功数据。
test('浮层同时展示旧行情与请求失败提示', function testPopupFailure() {
    const items = buildPopupItems(snapshot({ error: '接口超时' }), NOW);
    assert.match(items[0].label, /warning/);
    assert.match(items[0].detail, /上次成功行情/);
    assert.match(items[0].detail, /接口超时/);
});

// 定时刷新价格时保持正在输入的搜索词与股票焦点，并复用同一窗口。
test('实时更新保留搜索内容、滚动策略与焦点', function testSearchPreserved() {
    const harness = createQuickPickHarness();
    const popup = createQuotePopup({ window: harness, ThemeIcon: harness.ThemeIcon }, {
        // 为测试提供固定北京时间。
        now() { return NOW; }
    });
    popup.update(snapshot());
    assert.equal(harness.state.pickers.length, 0);
    popup.toggle();
    const picker = harness.state.pickers[0];
    picker.value = 'sz002649';
    picker.activeItems = [picker.items[1]];
    popup.update(snapshot({ quotes: [QUOTES[0], { ...QUOTES[1], price: '9.00' }, QUOTES[2]] }));
    assert.equal(picker.value, 'sz002649');
    assert.equal(picker.activeItems[0].code, 'sz002649');
    assert.match(picker.activeItems[0].label, /9.00/);
    assert.equal(picker.matchOnDescription, true);
    assert.equal(picker.keepScrollPosition, true);
    picker.hide();
    popup.update(snapshot());
    assert.equal(picker.visible, false);
    popup.toggle();
    assert.equal(harness.state.pickers.length, 1);
    assert.equal(picker.value, '');
    popup.dispose();
});

// 原生浮层工具按钮与回车、失焦关闭均正确接入且释放后不再触发。
test('浮层按钮、回车关闭与释放保持单实例', function testPopupButtons() {
    const harness = createQuickPickHarness();
    const calls = [];
    const popup = createQuotePopup({ window: harness, ThemeIcon: harness.ThemeIcon }, {
        // 固定时间以检查界面状态。
        now() { return NOW; },
        // 记录手动刷新入口。
        onRefresh() { calls.push('refresh'); },
        // 记录设置入口。
        onConfigure() { calls.push('configure'); },
        // 记录停止入口并模拟控制器关闭浮层。
        onStop() { calls.push('stop'); popup.hide(); }
    });
    popup.update(snapshot());
    popup.toggle();
    const picker = harness.state.pickers[0];
    harness.emit(picker, 'button', picker.buttons[0]);
    harness.emit(picker, 'button', picker.buttons[1]);
    assert.equal(picker.visible, false);
    popup.toggle();
    harness.emit(picker, 'button', picker.buttons[2]);
    assert.equal(picker.visible, false);
    assert.deepEqual(calls, ['refresh', 'configure', 'stop']);
    popup.toggle();
    harness.emit(picker, 'accept');
    assert.equal(picker.visible, false);
    popup.dispose();
    popup.dispose();
    harness.emit(picker, 'button', picker.buttons[0]);
    popup.toggle();
    assert.equal(picker.disposed, 1);
    assert.equal(harness.state.pickers.length, 1);
    assert.equal(calls.length, 3);
});
