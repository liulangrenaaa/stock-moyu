const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    parseQuoteTime,
    formatTime,
    getMarketState,
    getQuoteWarning,
    parseRetryAfter,
    getRefreshDelay
} = require('../refreshPolicy');

// 把测试用北京时间转换成绝对毫秒，避免宿主时区影响断言。
function time(value) {
    return Date.parse(`${value}+08:00`);
}

// 接口时间始终按北京时间解析，闰日和非法月份应严格区分。
test('行情时间解析与格式化不依赖系统时区', function testTimestamp() {
    assert.equal(parseQuoteTime('20261118100000'), Date.parse('2026-11-18T02:00:00Z'));
    assert.equal(formatTime(parseQuoteTime('20261118100000')), '2026-11-18 10:00:00');
    assert.notEqual(parseQuoteTime('20240229100000'), null);
    for (const value of ['20260229100000', '20261301100000', '20261118106000',
        '20261118100060', 20261118100000, undefined]) {
        assert.equal(parseQuoteTime(value), null);
    }
});

// 高频窗口包含开盘准备并保留短暂收盘缓冲，午休和周末降频。
test('北京时间交易窗口边界和周末判断', function testMarketWindows() {
    for (const [clock, active] of [
        ['09:14:59', false], ['09:15:00', true], ['11:29:59', true],
        ['11:30:00', false], ['12:59:59', false], ['13:00:00', true],
        ['15:04:59', true], ['15:05:00', false]
    ]) {
        assert.equal(getMarketState(time(`2026-11-18T${clock}`)).active, active, clock);
    }
    assert.equal(getMarketState(time('2026-11-21T10:00:00')).active, false);
    assert.equal(getMarketState(time('2026-11-22T10:00:00')).active, false);
});

// 休市只降低频率，不让一分钟等待或较大自定义间隔跨过开盘。
test('休市降频并在下一交易窗口及时唤醒', function testNextSession() {
    assert.equal(getRefreshDelay(3000, time('2026-11-18T12:00:00')), 60000);
    assert.equal(getRefreshDelay(3000, time('2026-11-18T12:59:40')), 20000);
    assert.equal(getRefreshDelay(3600000, time('2026-11-18T12:59:40')), 20000);
    assert.equal(getRefreshDelay(3000, time('2026-11-18T10:00:00')), 3000);
    assert.equal(getMarketState(time('2026-11-20T16:00:00')).nextOpenAt,
        time('2026-11-23T09:15:00'));
});

// 午休和周末快照应以最近交易结束时间判断，避免误报正常静止行情。
test('收盘和午休快照不按墙上时间误判过期', function testClosedSnapshots() {
    for (const [now, quote] of [
        ['2026-11-18T12:30:00', '2026-11-18T11:30:00'],
        ['2026-11-18T18:00:00', '2026-11-18T15:00:00'],
        ['2026-11-21T10:00:00', '2026-11-20T15:00:00'],
        ['2026-11-22T10:00:00', '2026-11-20T15:00:00'],
        ['2026-11-23T09:20:00', '2026-11-20T15:00:00']
    ]) {
        assert.equal(getQuoteWarning({ quoteTime: time(quote) }, time(now)), '');
    }
});

// 获取成功但行情较旧、未知或来自未来时都应明确提示。
test('识别过期、未知与超前的行情时间', function testStaleness() {
    const now = time('2026-11-18T10:00:00');
    assert.equal(getQuoteWarning({ quoteTime: now - 120000 }, now), '');
    assert.match(getQuoteWarning({ quoteTime: now - 120001 }, now), /较旧/);
    assert.match(getQuoteWarning({ quoteTime: now + 120001 }, now), /超前/);
    assert.match(getQuoteWarning({ quoteTime: null }, now), /未提供/);
    assert.match(getQuoteWarning({ quoteTime: time('2026-11-17T15:00:00') },
        time('2026-11-18T18:00:00')), /较旧/);
});

// 限流头支持规范的两种形式，过期或不合法的值不造成负等待。
test('Retry-After 解析秒数与 HTTP 日期并忽略异常值', function testRetryAfter() {
    const now = time('2026-11-18T10:00:00');
    assert.equal(parseRetryAfter(' 120 ', now), 120000);
    assert.equal(parseRetryAfter('Wed, 18 Nov 2026 02:02:00 GMT', now), 120000);
    for (const value of [undefined, '', '-1', '1.5', 'garbage',
        'Wed, 18 Nov 2026 01:59:00 GMT']) {
        assert.equal(parseRetryAfter(value, now), 0);
    }
    const huge = parseRetryAfter('9'.repeat(400), now);
    assert.equal(Number.isFinite(huge), true);
    assert.ok(huge > 2147483647);
});

// 指数退避有上限，用户长间隔和服务端最低等待不应被截短。
test('失败指数退避封顶且尊重限流与用户间隔', function testBackoff() {
    const now = time('2026-11-18T10:00:00');
    assert.equal(getRefreshDelay(3000, now, { failures: 1 }), 5000);
    assert.equal(getRefreshDelay(3000, now, { failures: 2 }), 10000);
    assert.equal(getRefreshDelay(3000, now, { failures: 1000 }), 300000);
    assert.equal(getRefreshDelay(3600000, now, { failures: 1000 }), 3600000);
    assert.equal(getRefreshDelay(3000, now, { failures: 1, statusCode: 429 }), 30000);
    assert.equal(getRefreshDelay(3000, now, { failures: 1, retryAfterMs: 600000 }),
        600000);
    assert.equal(getRefreshDelay(3000, time('2026-11-18T12:59:59'),
        { failures: 1, retryAfterMs: 600000 }), 600000);
});
