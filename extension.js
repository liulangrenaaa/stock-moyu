const {
    DEFAULT_CODES,
    DEFAULT_INTERVAL,
    normalizeStockCodes,
    normalizeInterval,
    formatQuotes,
    requestQuotes
} = require('./getStock');

let activeController;

// 管理单个状态栏和轮询会话，隔离停止或重启前的过期请求。
function createStockController(vscode, {
    fetchQuotes = requestQuotes,
    setTimer = setTimeout,
    clearTimer = clearTimeout
} = {}) {
    const item = vscode.window.createStatusBarItem(
        'stockMoyu.quotes', vscode.StatusBarAlignment.Left
    );
    item.name = 'Stock Moyu 股票行情';
    item.command = 'stockMoyu.stop';
    const output = vscode.window.createOutputChannel('Stock Moyu');
    let active = false;
    let disposed = false;
    let generation = 0;
    let timer = null;
    let pendingRequest = null;
    let latestText = '';
    let lastError = '';

    // 判断异步结果是否仍属于当前开启的会话。
    function isCurrent(session) {
        return active && !disposed && session === generation;
    }

    // 完成本次请求后再安排下一次，避免慢网络下的请求重叠。
    async function refresh(session) {
        if (!isCurrent(session)) return;
        let interval = DEFAULT_INTERVAL;
        try {
            const settings = vscode.workspace.getConfiguration('stockMoyu');
            interval = normalizeInterval(settings.get('updateInterval', DEFAULT_INTERVAL));
            const codes = normalizeStockCodes(settings.get('stockCodes', DEFAULT_CODES));
            pendingRequest = new AbortController();
            const quotes = await fetchQuotes(codes, { signal: pendingRequest.signal });
            if (!isCurrent(session)) return;
            latestText = formatQuotes(quotes);
            item.text = latestText;
            const missing = [];
            const returned = new Set();
            for (const quote of quotes) returned.add(quote.code);
            for (const code of codes) {
                if (!returned.has(code)) missing.push(code);
            }
            const details = [
                latestText,
                `获取时间：${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
            ];
            if (missing.length > 0) {
                item.text = `$(warning) ${latestText}`;
                details.push(`未返回有效行情：${missing.join(', ')}`);
            }
            details.push('点击停止行情');
            item.tooltip = details.join('\n');
            lastError = '';
        } catch (error) {
            if (!isCurrent(session)) return;
            const message = error instanceof Error ? error.message : String(error);
            item.text = latestText
                ? `$(warning) ${latestText}`
                : '$(warning) 行情暂不可用';
            item.tooltip = [
                message,
                latestText ? '当前显示上次成功获取的数据。' : '尚未获取到有效行情。',
                '稍后自动重试，点击停止行情。'
            ].join('\n');
            if (message !== lastError) {
                output.appendLine(message);
                lastError = message;
            }
        } finally {
            if (isCurrent(session)) {
                pendingRequest = null;
                // 保存唯一的待执行任务，停止时可以可靠清理。
                timer = setTimer(function onRefreshTimer() {
                    timer = null;
                    void refresh(session);
                }, interval);
            }
        }
    }

    // 重复开启保持幂等，首次开启立即请求而不等待刷新间隔。
    function start() {
        if (disposed || active) return;
        active = true;
        generation += 1;
        latestText = '';
        lastError = '';
        item.text = '$(sync~spin) 行情加载中';
        item.tooltip = '正在获取行情，点击停止。';
        item.show();
        void refresh(generation);
    }

    // 同时取消等待任务和进行中的请求，阻止关闭后回写界面。
    function stop() {
        active = false;
        generation += 1;
        if (timer !== null) clearTimer(timer);
        timer = null;
        pendingRequest?.abort();
        pendingRequest = null;
        item.hide();
    }

    // 仅在本插件配置变化时重启会话，使修改立即生效。
    function onConfigurationChanged(event) {
        if (active && event.affectsConfiguration('stockMoyu')) {
            stop();
            start();
        }
    }

    const listener = vscode.workspace.onDidChangeConfiguration(onConfigurationChanged);

    // 统一释放监听器和界面资源，允许停用与订阅清理重复调用。
    function dispose() {
        if (disposed) return;
        stop();
        disposed = true;
        listener.dispose();
        item.dispose();
        output.dispose();
    }

    return { start, stop, dispose };
}

// 注册独立命令，避免与已安装原版插件争用命令或配置。
function activate(context) {
    const vscode = require('vscode');
    activeController = createStockController(vscode);
    context.subscriptions.push(
        activeController,
        vscode.commands.registerCommand('stockMoyu.start', activeController.start),
        vscode.commands.registerCommand('stockMoyu.stop', activeController.stop)
    );
}

// 扩展停用时立即停止网络请求和轮询。
function deactivate() {
    activeController?.dispose();
    activeController = undefined;
}

module.exports = { activate, deactivate, createStockController };
