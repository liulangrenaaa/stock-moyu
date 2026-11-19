const { formatQuotes } = require('./getStock');
const { formatTime, getQuoteWarning, getMarketState } = require('./refreshPolicy');

// 限制状态栏展示数量，完整自选列表通过悬浮窗口查看。
function formatStatusBar(quotes, total, limit = 2) {
    const count = Number.isInteger(limit) ? Math.max(1, Math.min(10, limit)) : 2;
    const shown = quotes.slice(0, count);
    const remaining = Math.max(0, total - shown.length);
    return `${formatQuotes(shown)}${remaining ? `  |  +${remaining}只` : ''}`;
}

// 按自选顺序构造可搜索列表，缺失行情保留占位且不掩盖网络错误。
function buildPopupItems(state, now) {
    const quotes = new Map();
    for (const quote of state.quotes) quotes.set(quote.code, quote);
    const items = [];
    for (const code of state.codes) {
        const quote = quotes.get(code);
        if (!quote) {
            items.push({
                code,
                label: `${state.busy ? '$(sync~spin)' : '$(warning)'} ${code}`,
                description: state.busy ? '行情加载中' : '暂无有效行情',
                detail: state.error || '接口暂未返回此代码的有效行情'
            });
            continue;
        }
        const warning = state.error
            ? '请求失败，当前为上次成功行情'
            : getQuoteWarning(quote, now);
        const time = Number.isFinite(quote.quoteTime) ? formatTime(quote.quoteTime) : '未知';
        items.push({
            code,
            label: `${warning ? '$(warning) ' : ''}${formatQuotes([quote])}`,
            description: code,
            detail: `行情时间：${time}${warning ? `  |  ${warning}` : ''}`
                + (state.error ? `：${state.error}` : '')
        });
    }
    return items;
}

// 用原生 QuickPick 提供单实例行情浮层，实时更新时保留搜索词和选中位置。
function createQuotePopup(vscode, { onRefresh, onConfigure, onStop, now = Date.now }) {
    let picker;
    let visible = false;
    let disposed = false;
    let state = { codes: [], quotes: [], busy: false, error: '', fetchedAt: null };
    const subscriptions = [];

    // 只更新当前可见窗口，避免后台轮询重新打开已经关闭的浮层。
    function render() {
        if (!visible || !picker) return;
        const at = now();
        const activeCode = picker.activeItems[0]?.code;
        const market = getMarketState(at).active ? '交易时段' : '非交易时段';
        const retry = state.error && state.nextRefreshAt > at
            ? '等待自动重试'
            : '';
        const updated = Number.isFinite(state.fetchedAt)
            ? `获取 ${formatTime(state.fetchedAt).slice(11)}` : '';
        picker.title = ['自选行情', `${state.codes.length} 只`, retry || market, updated]
            .filter(Boolean).join(' · ');
        picker.placeholder = state.error || '搜索名称或代码';
        picker.busy = state.busy;
        picker.items = buildPopupItems(state, at);
        const activeItem = picker.items.find(
            // 刷新后恢复相同股票的键盘焦点，不跳回列表首行。
            function findActive(item) { return item.code === activeCode; }
        );
        if (activeItem) picker.activeItems = [activeItem];
    }

    // 缓存最近的行情快照，浮层关闭期间不创建额外网络请求。
    function update(value) {
        state = value;
        render();
    }

    // 显式隐藏并同步可见状态，兼容快捷键与宿主隐藏事件。
    function hide() {
        visible = false;
        picker?.hide();
    }

    // 配置变更重启轮询时保留用户正在查看浮层的状态。
    function isVisible() {
        return visible;
    }

    // 首次打开时延迟创建界面，其余调用在同一窗口上切换。
    function toggle() {
        if (disposed) return;
        if (visible) {
            hide();
            return;
        }
        if (!picker) {
            picker = vscode.window.createQuickPick();
            picker.matchOnDescription = true;
            picker.keepScrollPosition = true;
            const refresh = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: '刷新行情' };
            const configure = { iconPath: new vscode.ThemeIcon('gear'), tooltip: '编辑自选股票' };
            const stop = { iconPath: new vscode.ThemeIcon('debug-stop'), tooltip: '停止行情' };
            picker.buttons = [refresh, configure, stop];
            subscriptions.push(
                // 失焦、Esc 和其他输入框弹出时均正确记录浮层关闭。
                picker.onDidHide(function onHide() { visible = false; }),
                // 回车确认后收起浮层，回到原来的编辑位置。
                picker.onDidAccept(hide),
                // 工具栏复用控制器命令，不额外建立刷新循环。
                picker.onDidTriggerButton(function onButton(button) {
                    if (button === refresh) onRefresh();
                    if (button === configure) {
                        hide();
                        onConfigure();
                    }
                    if (button === stop) onStop();
                })
            );
        }
        visible = true;
        picker.value = '';
        render();
        picker.show();
    }

    // 卸载时释放浮层与事件，允许重复清理。
    function dispose() {
        if (disposed) return;
        disposed = true;
        visible = false;
        for (const subscription of subscriptions) subscription.dispose();
        picker?.dispose();
        picker = undefined;
    }

    return { update, toggle, hide, isVisible, dispose };
}

module.exports = { formatStatusBar, buildPopupItems, createQuotePopup };
