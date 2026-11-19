const {
    DEFAULT_CODES,
    DEFAULT_INTERVAL,
    normalizeStockCodes,
    normalizeInterval,
    formatQuotes,
    requestQuotes
} = require('./getStock');
const {
    MAX_TIMER_DELAY,
    formatTime,
    getMarketState,
    getQuoteWarning,
    getRefreshDelay
} = require('./refreshPolicy');
const { createQuotePopup, formatStatusBar } = require('./quotePopup');

let activeController;

// 管理单个状态栏和轮询会话，隔离停止或重启前的过期请求。
function createStockController(vscode, {
    fetchQuotes = requestQuotes,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = Date.now
} = {}) {
    const item = vscode.window.createStatusBarItem(
        'stockMoyu.quotes', vscode.StatusBarAlignment.Left
    );
    item.name = 'Stock Moyu 股票行情';
    item.command = 'stockMoyu.togglePopup';
    const output = vscode.window.createOutputChannel('Stock Moyu');
    let active = false;
    let disposed = false;
    let generation = 0;
    let timerGeneration = 0;
    let timer = null;
    let pendingRequest = null;
    let latestText = '';
    let latestDetails = [];
    let lastError = '';
    let failures = 0;
    let nextRefreshAt = 0;
    let popupState = {
        codes: [], quotes: [], busy: false, error: '', fetchedAt: null, nextRefreshAt: 0
    };
    const popup = createQuotePopup(vscode, {
        onRefresh: refreshNow,
        onConfigure: configure,
        onStop: stop,
        now
    });

    // 判断异步结果是否仍属于当前开启的会话。
    function isCurrent(session) {
        return active && !disposed && session === generation;
    }

    // 对超长等待分段计时，防止 Node.js 计时器溢出或提前触发导致绕过限流。
    function scheduleRefresh(session, delay) {
        const deadline = now() + delay;
        const scheduled = ++timerGeneration;
        // 每次唤醒重新检查截止时间，未到期时只继续等待。
        function onRefreshTimer() {
            if (!isCurrent(session) || scheduled !== timerGeneration) return;
            timer = null;
            const remaining = deadline - now();
            if (remaining > 0) {
                timer = setTimer(onRefreshTimer, Math.min(remaining, MAX_TIMER_DELAY));
            } else {
                void refresh(session);
            }
        }
        timer = setTimer(onRefreshTimer, Math.min(delay, MAX_TIMER_DELAY));
    }

    // 完成本次请求后再安排下一次，避免慢网络下的请求重叠。
    async function refresh(session) {
        if (!isCurrent(session)) return;
        let interval = DEFAULT_INTERVAL;
        let failure;
        let details;
        try {
            const settings = vscode.workspace.getConfiguration('stockMoyu');
            interval = normalizeInterval(settings.get('updateInterval', DEFAULT_INTERVAL));
            const codes = normalizeStockCodes(settings.get('stockCodes', DEFAULT_CODES));
            popupState = { ...popupState, codes, busy: true };
            popup.update(popupState);
            pendingRequest = new AbortController();
            const quotes = await fetchQuotes(codes, { signal: pendingRequest.signal });
            if (!isCurrent(session)) return;
            const fetchedAt = now();
            latestText = formatStatusBar(quotes, codes.length, settings.get('statusBarMaxStocks', 2));
            item.text = latestText;
            popupState = { ...popupState, quotes, fetchedAt, error: '' };
            const missing = [];
            const returned = new Set();
            for (const quote of quotes) returned.add(quote.code);
            for (const code of codes) {
                if (!returned.has(code)) missing.push(code);
            }
            details = [
                formatQuotes(quotes),
                `获取时间（北京时间）：${formatTime(fetchedAt)}`
            ];
            for (const quote of quotes) {
                const warning = getQuoteWarning(quote, fetchedAt);
                const time = Number.isFinite(quote.quoteTime)
                    ? formatTime(quote.quoteTime) : '未知';
                details.push(`${quote.name} 行情时间：${time}${warning ? `（${warning}）` : ''}`);
                if (warning) item.text = `$(warning) ${latestText}`;
            }
            if (missing.length > 0) {
                item.text = `$(warning) ${latestText}`;
                details.push(`未返回有效行情：${missing.join(', ')}`);
            }
            latestDetails = [...details];
            failures = 0;
            lastError = '';
        } catch (error) {
            if (!isCurrent(session)) return;
            failure = error;
            failures += 1;
            const message = error instanceof Error ? error.message : String(error);
            item.text = latestText
                ? `$(warning) ${latestText}`
                : '$(warning) 行情暂不可用';
            details = [
                message,
                latestText ? '当前显示上次成功获取的数据。' : '尚未获取到有效行情。',
                ...latestDetails
            ];
            popupState = { ...popupState, error: message };
            if (message !== lastError) {
                output.appendLine(message);
                lastError = message;
            }
        } finally {
            if (isCurrent(session)) {
                pendingRequest = null;
                const completedAt = now();
                const delay = getRefreshDelay(interval, completedAt, {
                    failures,
                    retryAfterMs: failure?.retryAfterMs,
                    statusCode: failure?.statusCode
                });
                details.push(
                    getMarketState(completedAt).active
                        ? '按交易时段刷新' : '非交易时段，降低刷新频率',
                    '时段按北京时间工作日判断，未接入节假日日历。',
                    `${failures ? '失败重试' : '下次刷新'}：${Math.ceil(delay / 1000)} 秒后`,
                    '自选行情'
                );
                item.tooltip = details.join('\n');
                nextRefreshAt = completedAt + delay;
                popupState = { ...popupState, busy: false, nextRefreshAt };
                popup.update(popupState);
                scheduleRefresh(session, delay);
            }
        }
    }

    // 重复开启保持幂等，首次开启立即请求而不等待刷新间隔。
    function start() {
        if (disposed || active) return;
        active = true;
        generation += 1;
        latestText = '';
        latestDetails = [];
        lastError = '';
        failures = 0;
        nextRefreshAt = 0;
        popupState = {
            codes: [], quotes: [], busy: true, error: '', fetchedAt: null, nextRefreshAt: 0
        };
        item.text = '$(sync~spin) 行情加载中';
        item.tooltip = '正在获取行情';
        item.show();
        void refresh(generation);
    }

    // 同时取消等待任务和进行中的请求，阻止关闭后回写界面。
    function stop() {
        active = false;
        generation += 1;
        timerGeneration += 1;
        if (timer !== null) clearTimer(timer);
        timer = null;
        pendingRequest?.abort();
        pendingRequest = null;
        popup.hide();
        item.hide();
    }

    // 手动刷新复用单个请求并遵守失败退避，避免按钮连击绕过接口限流。
    function refreshNow() {
        if (disposed) return;
        if (!active) {
            start();
            return;
        }
        if (pendingRequest || (failures > 0 && now() < nextRefreshAt)) {
            popup.update(popupState);
            return;
        }
        timerGeneration += 1;
        if (timer !== null) clearTimer(timer);
        timer = null;
        void refresh(generation);
    }

    // 首次通过快捷键查看时自动开启行情，再切换悬浮列表。
    function togglePopup() {
        if (disposed) return;
        if (!active) start();
        popup.update(popupState);
        popup.toggle();
    }

    // 打开自选配置入口，沿用 VS Code 对用户和工作区设置的管理。
    function configure() {
        return vscode.commands.executeCommand('workbench.action.openSettings', 'stockMoyu.stockCodes');
    }

    // 仅在本插件配置变化时重启会话，使修改立即生效。
    function onConfigurationChanged(event) {
        if (active && event.affectsConfiguration('stockMoyu')) {
            const reopen = popup.isVisible();
            stop();
            start();
            if (reopen) {
                popup.update(popupState);
                popup.toggle();
            }
        }
    }

    const listener = vscode.workspace.onDidChangeConfiguration(onConfigurationChanged);

    // 统一释放监听器和界面资源，允许停用与订阅清理重复调用。
    function dispose() {
        if (disposed) return;
        stop();
        disposed = true;
        listener.dispose();
        popup.dispose();
        item.dispose();
        output.dispose();
    }

    return { start, stop, dispose, togglePopup, refreshNow, configure };
}

// 注册独立命令，避免与已安装原版插件争用命令或配置。
function activate(context) {
    const vscode = require('vscode');
    activeController = createStockController(vscode);
    context.subscriptions.push(
        activeController,
        vscode.commands.registerCommand('stockMoyu.start', activeController.start),
        vscode.commands.registerCommand('stockMoyu.stop', activeController.stop),
        vscode.commands.registerCommand('stockMoyu.togglePopup', activeController.togglePopup),
        vscode.commands.registerCommand('stockMoyu.configure', activeController.configure)
    );
}

// 扩展停用时立即停止网络请求和轮询。
function deactivate() {
    activeController?.dispose();
    activeController = undefined;
}

module.exports = { activate, deactivate, createStockController };
