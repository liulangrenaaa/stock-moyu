// 提供原生悬浮列表的最小可观察替身，统一模拟交互和事件清理。
function createQuickPickHarness() {
    const state = { pickers: [], commands: [] };
    const events = new Map();

    // 创建可移除监听器，防止释放后的按钮继续调用控制器。
    function subscribe(picker, event, listener) {
        const listeners = events.get(picker)[event];
        listeners.add(listener);
        return {
            // 模拟 VS Code 事件订阅释放。
            dispose() { listeners.delete(listener); }
        };
    }

    // 将模拟事件交给当前仍有效的订阅者。
    function emit(picker, event, value) {
        for (const listener of events.get(picker)[event]) listener(value);
    }

    // 每次宿主创建窗口时记录实例数量，便于检查重复打开和泄漏。
    function createQuickPick() {
        const picker = {
            value: '', title: '', placeholder: '', items: [], activeItems: [],
            buttons: [], visible: false, disposed: 0, shows: 0,
            // 显示同一实例并记录调用次数。
            show() { this.visible = true; this.shows += 1; },
            // 模拟 Esc 或失焦关闭浮层。
            hide() { this.visible = false; emit(this, 'hide'); },
            // 释放原生列表。
            dispose() { this.disposed += 1; this.visible = false; },
            // 订阅浮层关闭事件。
            onDidHide(listener) { return subscribe(this, 'hide', listener); },
            // 订阅回车确认事件。
            onDidAccept(listener) { return subscribe(this, 'accept', listener); },
            // 订阅工具栏点击事件。
            onDidTriggerButton(listener) { return subscribe(this, 'button', listener); }
        };
        events.set(picker, { hide: new Set(), accept: new Set(), button: new Set() });
        state.pickers.push(picker);
        return picker;
    }

    // 只记录图标名称，不依赖真实 VS Code 图标资源。
    function ThemeIcon(id) { this.id = id; }

    const commands = {
        // 保存设置命令参数，验证没有修改其他扩展的配置。
        executeCommand(...args) { state.commands.push(args); return Promise.resolve(); }
    };
    return { state, createQuickPick, ThemeIcon, commands, emit };
}

module.exports = { createQuickPickHarness };
