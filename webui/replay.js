/* 图形变化重播：先保留变化前状态 2.5 秒观察时间，显示结果后立即结束回放。 */
(function (root) {
  'use strict';

  const REPLAY_BEFORE_MS = 2500;

  class ReplayController {
    constructor({
      button,
      stage,
      status,
      flow,
      filePanel,
      graph,
      getState,
      animateFiles,
      matchMedia = query => root.matchMedia(query),
      setTimeout = (fn, delay) => root.setTimeout(fn, delay),
      clearTimeout = id => root.clearTimeout(id)
    }) {
      this.button = button;
      this.stage = stage;
      this.status = status;
      this.flow = flow;
      this.filePanel = filePanel;
      this.graph = graph;
      this.getState = getState;
      this.animateFiles = animateFiles;
      this.matchMedia = matchMedia;
      this.setTimeout = setTimeout;
      this.clearTimeout = clearTimeout;
      this.timer = null;
      this.lastResult = null;
      this.button.textContent = '▷ 重播变化';
      this.button.title = '先观察变化前的图，再显示结果；播放时可点击停止。';
      this.button.disabled = true;
    }

    setResult(result) {
      this.lastResult = result || null;
      this.button.disabled = !this.lastResult;
    }

    reset() {
      this.lastResult = null;
      this.cancel();
    }

    /** 取消时恢复真实当前视图，避免停在历史起点；从不重新执行命令或回退仓库。 */
    cancel() {
      const wasPlaying = this.timer !== null;
      if (this.timer) {
        this.clearTimeout(this.timer);
      }
      this.timer = null;
      this.stage.classList.remove('replaying');
      if (wasPlaying) {
        this.graph.draw(this.getState());
        this.flow.classList.remove('flash');
        this.filePanel.classList.remove('file-flowing', 'commit-flowing');
      }
      this.status.hidden = true;
      this.button.textContent = '▷ 重播变化';
      this.button.setAttribute('aria-pressed', 'false');
      this.button.disabled = !this.lastResult;
    }

    replay() {
      if (!this.lastResult) return;
      if (this.timer !== null) {
        this.cancel();
        return;
      }
      this.cancel();
      // 清掉正常命令留下的动画类，起点阶段只观察，不提前播放文件高亮。
      this.flow.classList.remove('flash');
      this.filePanel.classList.remove('file-flowing', 'commit-flowing');
      const result = this.lastResult;
      const before = result.graphBefore || result.before;
      const after = result.graphAfter || result.after;
      const reduced = this.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.button.textContent = '■ 停止重播';
      this.button.setAttribute('aria-pressed', 'true');
      this.stage.classList.add('replaying');
      this.graph.draw(before);
      this.status.hidden = false;
      this.status.textContent = '变化前状态，稍后显示结果。';
      this.timer = this.setTimeout(() => {
        // 先结束等待，再绘制结果，避免清理时重绘并打断正常的切换动画。
        this.timer = null;
        this.cancel();
        this.graph.draw(after, { animate: !reduced });
        if (!reduced) {
          this.animateFiles(result);
        }
      }, REPLAY_BEFORE_MS);
    }
  }

  const api = { REPLAY_BEFORE_MS, ReplayController };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GitReplay = api;
})(globalThis);
