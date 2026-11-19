(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const NODE_RADIUS = 19, LABEL_HEIGHT = 25, LABEL_GAP = 52;
  const EDGE_CLEARANCE = 32;
  const DEFAULT_ZOOM = 1.15;
  const READABLE_SCALE = .85;
  const labelWidth = text => Math.max(54, [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 11 : 6.8), 18));
  // 本地分支预留星号宽度，切换 HEAD 只改变标识，不推动后续提交。
  const referenceWidth = ref => labelWidth(ref.text + (ref.key.startsWith('local:') && !ref.active ? '*' : ''));
  const element = (name, attrs = {}, text) => {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /** 取样只用于比较路径与障碍物；实际输出仍保留 SVG 曲线和圆角。 */
  function routePath(commands) {
    const segments = []; let point;
    const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    const include = p => {
      bounds.left = Math.min(bounds.left, p.x); bounds.right = Math.max(bounds.right, p.x);
      bounds.top = Math.min(bounds.top, p.y); bounds.bottom = Math.max(bounds.bottom, p.y);
    };
    for (const [type, ...values] of commands) {
      const controls = [];
      for (let i = 0; i < values.length; i += 2) controls.push({ x: values[i], y: values[i + 1] });
      if (type === 'M') { point = controls[0]; include(point); continue; }
      const curve = [point, ...controls], steps = type === 'L' ? 1 : 32;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps; let sample = curve;
        while (sample.length > 1) sample = sample.slice(1).map((p, j) => ({ x: sample[j].x * (1 - t) + p.x * t, y: sample[j].y * (1 - t) + p.y * t }));
        segments.push([point, sample[0]]); point = sample[0]; include(point);
      }
    }
    return { path: commands.map(([type, ...values]) => type + ' ' + values.join(' ')).join(' '), segments, bounds };
  }

  function throughBox([a, b], box) {
    let enter = 0, leave = 1;
    for (const axis of ['x', 'y']) {
      const delta = b[axis] - a[axis], low = box[axis], high = low + (axis === 'x' ? box.width : box.height);
      if (Math.abs(delta) < .001) { if (a[axis] < low || a[axis] > high) return false; }
      else {
        const first = (low - a[axis]) / delta, last = (high - a[axis]) / delta;
        enter = Math.max(enter, Math.min(first, last)); leave = Math.min(leave, Math.max(first, last));
        if (enter > leave) return false;
      }
    }
    return true;
  }

  /** 穿越和贴线分别计价；取样端点也参与检测，避免漏掉恰好位于曲线中点的交叉。 */
  function lineContact([a, b], [c, d]) {
    if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) return 0;
    const cross = (x, y) => x.x * y.y - x.y * y.x, subtract = (x, y) => ({ x: x.x - y.x, y: x.y - y.y });
    const u = subtract(b, a), v = subtract(d, c), between = subtract(c, a), denominator = cross(u, v);
    if (Math.abs(denominator) < .001) {
      if (Math.abs(cross(between, u)) > .01) return 0;
      const length = Math.hypot(u.x, u.y); if (length < .001) return 0;
      const project = p => ((p.x - a.x) * u.x + (p.y - a.y) * u.y) / length;
      return Math.max(0, Math.min(length, Math.max(project(c), project(d))) - Math.max(0, Math.min(project(c), project(d))));
    }
    const t = cross(between, v) / denominator, s = cross(between, u) / denominator;
    return t >= -.001 && t <= 1.001 && s >= -.001 && s <= 1.001 ? -1 : 0;
  }

  function roundedRoute(points) {
    const commands = [['M', points[0].x, points[0].y]];
    for (let i = 1; i < points.length - 1; i++) {
      const before = points[i - 1], point = points[i], after = points[i + 1];
      const incoming = Math.hypot(point.x - before.x, point.y - before.y), outgoing = Math.hypot(after.x - point.x, after.y - point.y);
      if (!incoming || !outgoing) continue;
      const radius = Math.min(12, incoming / 2, outgoing / 2);
      commands.push(['L', point.x + (before.x - point.x) * radius / incoming, point.y + (before.y - point.y) * radius / incoming]);
      commands.push(['Q', point.x, point.y, point.x + (after.x - point.x) * radius / outgoing, point.y + (after.y - point.y) * radius / outgoing]);
    }
    const end = points[points.length - 1]; commands.push(['L', end.x, end.y]);
    return routePath(commands);
  }

  /** 图中同时区分本地已知对象与虚拟远程对象；箭头由子提交指向父提交。 */
  class CommitGraph {
    constructor(svg, onSelect) {
      this.svg = svg;
      this.onSelect = onSelect;
      this.zoom = DEFAULT_ZOOM;
      this.fitted = false;
      this.previous = new Map();
    }

    references(state) {
      const refs = [
        ...Object.entries(state.tags || {}).map(([name, tag]) => ({ key: 'tag:' + name, text: 'tag: ' + name, id: tag.id, color: '#fde68a' })),
        ...Object.entries(state.branches).map(([name, id]) => ({ key: 'local:' + name, text: name + (state.head.branch === name ? '*' : ''), id, active: state.head.branch === name, color: '#3988b6' })),
        ...Object.entries(state.tracking).map(([name, id]) => ({ key: 'tracking:' + name, text: 'origin/' + name, id, color: '#b4d3e1', small: true })),
        ...Object.entries(state.remote.branches).filter(([name, id]) => state.tracking[name] !== id).map(([name, id]) => ({ key: 'remote:' + name, text: '远端/' + name, id, color: '#b5b0ed', small: true }))
      ];
      if (!state.head.branch) refs.unshift({ key: 'head', text: 'HEAD*', id: state.head.id, active: true });
      return refs;
    }

    /** 连续提交继承父通道；同层分叉时上下分开，不按提交创建顺序重新排队。 */
    columns(rows) {
      const columns = new Map();
      for (const row of rows) {
        const preferred = row.map(commit => ({
          commit,
          column: commit.parents.length ? commit.parents.reduce((sum, id) => sum + columns.get(id), 0) / commit.parents.length : 0
        })).sort((a, b) => a.column - b.column || a.commit.order - b.commit.order);
        const blocks = [];
        // 减去序号后约束位置单调：只合并重叠区间，以最小平移保证相邻节点至少相隔一列。
        preferred.forEach((item, i) => {
          blocks.push({ start: i, end: i, sum: item.column - i, count: 1 });
          while (blocks.length > 1) {
            const right = blocks[blocks.length - 1], left = blocks[blocks.length - 2];
            if (left.sum / left.count <= right.sum / right.count) break;
            blocks.splice(-2, 2, { start: left.start, end: right.end, sum: left.sum + right.sum, count: left.count + right.count });
          }
        });
        for (const block of blocks) for (let i = block.start; i <= block.end; i++) columns.set(preferred[i].commit.id, block.sum / block.count + i);
      }
      return columns;
    }

    /** 时间从左向右，分支沿纵向通道展开；每层为正向文字标签预留实际宽度。 */
    layout(state) {
      const objects = { ...state.remote.commits, ...state.commits };
      const commits = Object.values(objects).sort((a, b) => a.order - b.order);
      const depths = new Map(), rows = new Map(), positions = new Map(), exits = new Map();
      const refs = this.references(state);
      const labelOffsets = new Map(), labelEnds = new Map(), byCommit = new Map();
      for (const ref of refs) { if (!byCommit.has(ref.id)) byCommit.set(ref.id, []); byCommit.get(ref.id).push(ref); }
      // 每两张标签分置通道上下方；多组标签沿时间轴排开，长名称也不挤占相邻分支。
      for (const [id, group] of byCommit) {
        let offset = 36;
        for (let i = 0; i < group.length; i += 2) {
          const pair = group.slice(i, i + 2);
          for (const ref of pair) labelOffsets.set(ref.key, offset);
          offset += Math.max(...pair.map(referenceWidth)) + 24;
        }
        labelEnds.set(id, offset);
      }
      const depth = id => {
        if (!depths.has(id)) depths.set(id, objects[id].parents.length ? 1 + Math.max(...objects[id].parents.map(depth)) : 0);
        return depths.get(id);
      };
      for (const commit of commits) { const d = depth(commit.id); if (!rows.has(d)) rows.set(d, []); rows.get(d).push(commit); }
      const layers = [...rows].sort((a, b) => a[0] - b[0]);
      const columns = this.columns(layers.map(([, row]) => row));
      const minColumn = Math.min(...columns.values()), maxColumn = Math.max(...columns.values()), centerColumn = (minColumn + maxColumn) / 2;
      const laneGap = 250, padding = 120;
      const height = Math.max(270, (maxColumn - minColumn) * laneGap + padding * 2);
      let x = 60, width = 540;
      for (const [, row] of layers) {
        row.forEach(commit => {
          const y = height / 2 + (columns.get(commit.id) - centerColumn) * laneGap;
          positions.set(commit.id, { x, y });
        });
        const clearance = Math.max(NODE_RADIUS + 26, ...row.map(commit => labelEnds.get(commit.id) || 0));
        exits.set(depth(row[0].id), x + clearance);
        width = Math.max(width, x + clearance + 30);
        x += Math.max(112, clearance + NODE_RADIUS + 12 + EDGE_CLEARANCE);
      }
      const labels = this.labelPositions(refs, positions, labelOffsets);
      const edges = this.routeEdges(commits, positions, depths, exits, labels, height);
      return { commits, objects, positions, width, height, edges, labels };
    }

    /** 绘制和避障共用标签尺寸，连 HEAD 说明的下沿也保留空间。 */
    labelPositions(refs, positions, offsets) {
      const counters = new Map();
      return refs.map(ref => {
        const point = positions.get(ref.id), index = counters.get(ref.id) || 0;
        counters.set(ref.id, index + 1);
        const labelW = referenceWidth(ref), above = index % 2 === 0, height = ref.active ? LABEL_HEIGHT + 20 : LABEL_HEIGHT;
        const x = point.x + offsets.get(ref.key), y = above ? point.y - LABEL_GAP - height : point.y + LABEL_GAP;
        return { ref, point, above, x, y, width: labelW, height };
      });
    }

    /** 先铺相邻层提交链，再为跨层边选路径；长度、交叉及重叠共同参与评分，顺序与 HEAD 无关。 */
    routeEdges(commits, positions, depths, exits, labels, height) {
      const edges = commits.flatMap(commit => commit.parents.map(parent => ({ commit: commit.id, parent, span: depths.get(commit.id) - depths.get(parent) })));
      const ports = (key, opposite) => {
        const groups = new Map(), offsets = new Map();
        for (const edge of edges) { if (!groups.has(edge[key])) groups.set(edge[key], []); groups.get(edge[key]).push(edge); }
        for (const group of groups.values()) {
          group.sort((a, b) => positions.get(a[opposite]).y - positions.get(b[opposite]).y || positions.get(a[opposite]).x - positions.get(b[opposite]).x);
          group.forEach((edge, i) => offsets.set(edge, group.length === 1 ? 0 : (2 * i / (group.length - 1) - 1) * 9));
        }
        return offsets;
      };
      const starts = ports('commit', 'parent'), ends = ports('parent', 'commit');
      const obstacles = labels.map(label => ({ x: label.x - 6, y: label.y - 6, width: label.width + 12, height: label.height + 12 }));
      const nodeBoxes = [...positions].map(([id, point]) => ({ id, x: point.x - NODE_RADIUS - 6, y: point.y - NODE_RADIUS - 6, width: (NODE_RADIUS + 6) * 2, height: (NODE_RADIUS + 6) * 2 }));
      const routed = [];
      for (const edge of [...edges].sort((a, b) => a.span - b.span)) {
        const point = positions.get(edge.commit), to = positions.get(edge.parent), startOffset = starts.get(edge), endOffset = ends.get(edge);
        const start = { x: point.x - Math.sqrt((NODE_RADIUS + 1) ** 2 - startOffset ** 2), y: point.y + startOffset };
        const end = { x: to.x + Math.sqrt((NODE_RADIUS + 6) ** 2 - endOffset ** 2), y: to.y + endOffset };
        const exit = exits.get(depths.get(edge.parent));
        const candidates = [0.5, .18, .82].map(ratio => {
          const bend = exit + (start.x - exit) * ratio;
          return routePath([['M', start.x, start.y], ['C', bend, start.y, bend, end.y, exit, end.y], ['L', end.x, end.y]]);
        });
        const blockers = [...obstacles, ...nodeBoxes.filter(box => box.id !== edge.commit && box.id !== edge.parent)];
        if (edge.span > 1) {
          const incoming = (exits.get(depths.get(edge.commit) - 1) + start.x) / 2;
          const lanes = new Set([start.y, end.y, (start.y + end.y) / 2, 12, height - 12]);
          // 就近尝试障碍物两侧，不再把所有跨层边赶到画布同一侧。
          for (const box of blockers) for (const lane of [box.y - 14, box.y + box.height + 14]) if (lane >= 12 && lane <= height - 12) lanes.add(lane);
          for (const lane of lanes) candidates.push(roundedRoute([start, { x: incoming, y: start.y }, { x: incoming, y: lane }, { x: exit, y: lane }, { x: exit, y: end.y }, end]));
        }
        let best, bestScore = Infinity;
        for (const candidate of candidates) {
          const { left, right, top, bottom } = candidate.bounds;
          // 路径包围盒不相交时无需逐段比较；接触边界的候选仍按原规则计分。
          if (blockers.some(box => right >= box.x && left <= box.x + box.width && bottom >= box.y && top <= box.y + box.height &&
            candidate.segments.some(segment => throughBox(segment, box)))) continue;
          let score = candidate.segments.reduce((sum, [a, b]) => sum + Math.hypot(b.x - a.x, b.y - a.y), 0);
          for (const previous of routed) {
            if (right < previous.bounds.left || left > previous.bounds.right || bottom < previous.bounds.top || top > previous.bounds.bottom) continue;
            let crossing = false, overlap = 0;
            for (const segment of candidate.segments) for (const other of previous.segments) {
              const contact = lineContact(segment, other); crossing ||= contact < 0; overlap += Math.max(0, contact);
            }
            score += (crossing ? 280 : 0) + overlap * 8;
          }
          if (score < bestScore) { best = candidate; bestScore = score; }
        }
        // 相邻层边已由层间留白保证可通行；保底仍保留正确父子关系。
        const selected = best || candidates[0]; edge.path = selected.path; routed.push(selected);
      }
      return edges;
    }

    draw(state, options = {}) {
      this.state = state;
      const svg = this.svg, layout = this.layout(state), positions = layout.positions;
      this.size = { width: layout.width, height: layout.height };
      svg.replaceChildren(); svg.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + layout.height);
      const title = element('title', {}, 'Git 提交图。旧提交在左，新提交在右；箭头向左指向父提交，亮绿色标签表示当前分支。'); svg.append(title);
      const defs = element('defs');
      for (const [id, color] of [['parent-arrow', '#294a60'], ['label-arrow', '#fff']]) {
        const marker = element('marker', { id, markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto', markerUnits: 'userSpaceOnUse' });
        marker.append(element('path', { d: 'M0,0 L8,4 L0,8 Z', fill: color })); defs.append(marker);
      }
      svg.append(defs);
      const head = state.head.branch ? state.branches[state.head.branch] : state.head.id;
      const reachable = new Set();
      const visit = id => { if (!id || reachable.has(id)) return; reachable.add(id); layout.objects[id].parents.forEach(visit); };
      [...Object.values(state.branches), ...Object.values(state.tracking), ...Object.values(state.remote.branches), ...Object.values(state.tags || {}).map(tag => tag.id), head].forEach(visit);
      for (const route of layout.edges) {
        const edge = element('path', { class: 'commit-edge', d: route.path, 'marker-end': 'url(#parent-arrow)' });
        if (!reachable.has(route.commit)) { edge.setAttribute('opacity', '.28'); edge.setAttribute('stroke-dasharray', '5 4'); }
        if (!Object.hasOwn(state.commits, route.commit)) edge.setAttribute('stroke-dasharray', '5 4');
        svg.append(edge);
      }
      for (const commit of layout.commits) {
        const point = positions.get(commit.id), local = Object.hasOwn(state.commits, commit.id);
        const orphan = !reachable.has(commit.id), active = commit.id === head;
        const group = element('g', { class: 'commit-node' + (orphan ? ' orphan' : '') + (!local ? ' remote-only' : '') + (options.animate && !this.previous.has(commit.id) ? ' new-node' : ''), transform: `translate(${point.x} ${point.y})`, tabindex: 0, role: 'button', 'aria-label': commit.id + ' ' + commit.message + (!local ? '，仅远程拥有' : '') });
        group.append(element('title', {}, commit.id + ' · ' + commit.message + (orphan ? '（失去引用的历史）' : '')));
        group.append(element('circle', { r: NODE_RADIUS, fill: active ? '#7bffc4' : orphan ? '#94c3d7' : !local ? '#b0b1ed' : '#55b5ba' }));
        group.append(element('text', { 'text-anchor': 'middle', dy: 5 }, commit.id));
        group.append(element('text', { class: 'node-hash', y: -34, 'text-anchor': 'middle' }, !local ? '仅在远程' : ''));
        const select = () => {
          svg.querySelectorAll('.node-selected').forEach(node => node.classList.remove('node-selected'));
          group.classList.add('node-selected'); this.onSelect(commit, !local);
        };
        group.addEventListener('click', select);
        group.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); select(); } });
        svg.append(group);
      }
      const tagPositions = new Map();
      for (const { ref, point, above, x, y, width, height } of layout.labels) {
        const previous = this.previousTags?.get(ref.key);
        // 引用目标和 HEAD 身份也算变化，不能只比较坐标：同位置切分支仍需提示。
        const changed = options.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches &&
          (!previous || previous.id !== ref.id || previous.active !== ref.active || previous.x !== x || previous.y !== y);
        const group = element('g', { class: 'branch-tag' + (changed ? ' changed-ref' : ''), 'data-ref': ref.key, transform: `translate(${x} ${y})` });
        const endX = point.x - x + 10, endY = point.y - y + (above ? -16 : 16);
        // 指针从标签朝向节点的一侧接入，沿通道内侧绕开同节点的其他标签。
        const startY = above ? LABEL_HEIGHT - 5 : 5, bendY = point.y - y + (above ? -32 : 32);
        const innerY = above ? height + 12 : -12;
        group.append(element('path', { class: 'branch-pointer', d: `M 0 ${startY} L -12 ${innerY} Q -12 ${bendY} ${endX} ${endY}`, 'marker-end': 'url(#label-arrow)' }));
        group.append(element('rect', { width, height: LABEL_HEIGHT, rx: 7, fill: ref.active ? '#00fa8f' : ref.color, 'stroke-dasharray': ref.small ? '4 2' : 'none' }));
        group.append(element('text', { x: width / 2, y: 17, 'text-anchor': 'middle' }, ref.text));
        if (ref.active) group.append(element('text', { class: 'head-caption', x: width / 2, y: 39, 'text-anchor': 'middle' }, state.head.branch ? 'HEAD' : '分离状态'));
        svg.append(group); tagPositions.set(ref.key, { x, y, id: ref.id, active: ref.active });
        if (changed) {
          // 慢速回放用线性淡入配合持续高亮，避免 ease-out 在开头就显得已经结束。
          group.animate([{ opacity: .35 }, { opacity: 1 }], { duration: options.animationDuration ?? 450, easing: options.animationDuration ? 'linear' : 'ease-out' });
        }
      }
      this.previous = positions; this.previousTags = tagPositions;
      this.resize();
    }

    resize() {
      if (!this.size) return;
      const parent = this.svg.parentElement, width = parent.clientWidth || 600, height = parent.clientHeight || 240;
      // 默认保留可读比例，显式适应时才缩至整图可见；两个轴始终采用相同的比例。
      const fit = Math.min(width / this.size.width, height / this.size.height);
      const baseline = Math.max(fit, READABLE_SCALE), scale = this.fitted ? fit : baseline * this.zoom;
      if (this.fitted) this.zoom = fit / baseline;
      const graphWidth = this.size.width * scale, graphHeight = this.size.height * scale;
      const style = this.svg.style;
      style.minWidth = '0';
      style.width = graphWidth + 'px';
      style.height = graphHeight + 'px';
      style.marginLeft = Math.max(0, (width - graphWidth) / 2) + 'px';
      style.marginTop = Math.max(0, (height - graphHeight) / 2) + 'px';
    }

    setZoom(value) {
      this.fitted = false;
      this.zoom = Math.max(.6, Math.min(2.5, value));
      this.resize();
    }

    fit() {
      this.fitted = true;
      this.resize();
    }
  }
  CommitGraph.DEFAULT_ZOOM = DEFAULT_ZOOM;
  root.CommitGraph = CommitGraph;
})(globalThis);
