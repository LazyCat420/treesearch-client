/**
 * Cannabis Researcher — Frontend Application
 * Fetches network data from the API and renders an interactive strain graph.
 */

(function () {
  'use strict';

  // ── State ──
  const state = {
    nodes: null,          // vis.DataSet
    edges: null,          // vis.DataSet
    network: null,        // vis.Network
    allNodes: [],
    allRelationships: [],
    allTerpeneRels: [],
    activeNodes: new Set(),
    currentEdges: new Set(),
    relType: 'genetic',   // 'genetic' | 'terpene' | 'combined'
    currentView: 'network',
    physicsOn: false,
  };

  // ── Color palette ──
  const COLORS = {
    genetic:  { edge: '#00d2ff', bg: 'rgba(0,210,255,0.12)', node: '#3a7bd5' },
    terpene:  { edge: '#00c853', bg: 'rgba(0,200,83,0.12)',  node: '#7cb342' },
    combined: { edge: '#e040fb', bg: 'rgba(224,64,251,0.12)', node: '#9c27b0' },
    complete: { bg: '#3a7bd5', border: '#5c9ce6' },
    incomplete: { bg: '#333348', border: '#555568' },
    selected: { bg: '#ef5350', border: '#ff7043' },
  };

  // ── Init ──
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    try {
      const resp = await fetch('/api/network-data');
      const data = await resp.json();
      state.allNodes = data.nodes || [];
      state.allRelationships = data.relationships || [];
      state.allTerpeneRels = data.terpeneRelationships || [];
      renderStats();
      buildGraph();
      bindEvents();
    } catch (err) {
      console.error('Failed to load network data:', err);
      toast('Failed to load data');
    }
  }

  // ── Stats Bar ──
  function renderStats() {
    const complete = state.allNodes.filter(n => n.complete).length;
    document.getElementById('stats-bar').innerHTML = `
      <div class="stat-chip"><strong>${state.allNodes.length}</strong> strains</div>
      <div class="stat-chip"><strong>${complete}</strong> complete</div>
      <div class="stat-chip"><strong>${state.allRelationships.length}</strong> relationships</div>
    `;
  }

  // ── Build Vis.js Graph ──
  function buildGraph() {
    const container = document.getElementById('graph-container');

    // Map nodes with dark-mode colors
    const nodeData = state.allNodes.map(n => ({
      id: n.id,
      label: (n.label || n.id).replace(/_/g, ' '),
      title: `${(n.label||n.id).replace(/_/g,' ')}\nRSP: ${n.rsp || '—'}\n${n.complete ? 'Complete data' : 'Incomplete'}`,
      color: {
        background: n.complete ? COLORS.complete.bg : COLORS.incomplete.bg,
        border: n.complete ? COLORS.complete.border : COLORS.incomplete.border,
        highlight: { background: COLORS.selected.bg, border: COLORS.selected.border },
        hover: { background: n.complete ? '#4a8ce8' : '#444460', border: n.complete ? '#6eaaff' : '#666680' },
      },
      font: { color: '#e8e8f0', strokeWidth: 2, strokeColor: '#0a0a14', size: 13 },
      rsp: n.rsp,
      complete: n.complete,
      size: n.complete ? 18 : 12,
      borderWidth: 2,
      shadow: { enabled: true, color: 'rgba(0,0,0,0.5)', size: 8 },
    }));

    state.nodes = new vis.DataSet(nodeData);
    state.edges = new vis.DataSet([]);

    state.network = new vis.Network(container, {
      nodes: state.nodes,
      edges: state.edges,
    }, {
      nodes: { shape: 'dot' },
      edges: { width: 1.5, smooth: { type: 'continuous' }, color: { opacity: 0.5 } },
      layout: { improvedLayout: true, randomSeed: 42 },
      physics: {
        enabled: true,
        stabilization: { enabled: true, iterations: 200, updateInterval: 25 },
        repulsion: { nodeDistance: 200, centralGravity: 0.08, springLength: 280, springConstant: 0.04, damping: 0.09 },
      },
      interaction: { hover: true, tooltipDelay: 200, zoomView: true, dragView: true, hideEdgesOnDrag: true, hideEdgesOnZoom: true },
    });

    // Disable physics after stabilization
    state.network.once('stabilizationIterationsDone', () => {
      state.network.setOptions({ physics: { enabled: false } });
      state.physicsOn = false;
    });

    // Node click
    state.network.on('click', params => {
      if (params.nodes.length > 0) {
        handleNodeClick(params.nodes[0]);
      }
    });
  }

  // ── Node Click ──
  function handleNodeClick(nodeId) {
    const node = state.nodes.get(nodeId);
    if (!node) return;

    // Toggle active
    if (state.activeNodes.has(nodeId)) {
      state.activeNodes.delete(nodeId);
      removeEdgesFor(nodeId);
      resetNodeColor(nodeId, node);
    } else {
      state.activeNodes.add(nodeId);
      addEdgesFor(nodeId);
      state.nodes.update({
        id: nodeId,
        color: { background: COLORS.selected.bg, border: COLORS.selected.border },
      });
    }

    // Load detail
    loadStrainDetail(nodeId);
  }

  function resetNodeColor(nodeId, node) {
    state.nodes.update({
      id: nodeId,
      color: {
        background: node.complete ? COLORS.complete.bg : COLORS.incomplete.bg,
        border: node.complete ? COLORS.complete.border : COLORS.incomplete.border,
      },
    });
  }

  // ── Edge Management ──
  function getRelationships(nodeId) {
    if (state.relType === 'genetic') {
      return findConnections(nodeId, state.allRelationships);
    } else if (state.relType === 'terpene') {
      return findConnections(nodeId, state.allTerpeneRels);
    } else {
      // Combined: merge both
      const g = findConnections(nodeId, state.allRelationships);
      const t = findConnections(nodeId, state.allTerpeneRels);
      const seen = new Set(g.map(r => `${r.from}-${r.to}`));
      t.forEach(r => { if (!seen.has(`${r.from}-${r.to}`)) g.push(r); });
      return g;
    }
  }

  function findConnections(nodeId, pool) {
    let threshold = 0.2;
    let conns = [];
    while (threshold <= 1.0) {
      conns = pool.filter(r =>
        (r.from === nodeId || r.to === nodeId) && r.distance <= threshold
      ).sort((a, b) => a.distance - b.distance);
      if (conns.length > 0) break;
      threshold += 0.1;
    }
    return conns;
  }

  function addEdgesFor(nodeId) {
    const rels = getRelationships(nodeId);
    const edgeColor = COLORS[state.relType].edge;

    rels.forEach(rel => {
      const eid = [rel.from, rel.to].sort().join('|');
      if (!state.currentEdges.has(eid)) {
        state.edges.add({
          id: eid,
          from: rel.from,
          to: rel.to,
          value: 1 - rel.distance,
          length: rel.distance * 400,
          title: `${capitalize(state.relType)} Distance: ${rel.distance.toFixed(3)}`,
          color: { color: edgeColor, opacity: Math.max(0.25, 1 - rel.distance) },
          width: Math.max(1, 3 * (1 - rel.distance)),
        });
        state.currentEdges.add(eid);
      }
    });
  }

  function removeEdgesFor(nodeId) {
    const toRemove = [];
    state.edges.forEach(edge => {
      if (edge.from === nodeId || edge.to === nodeId) {
        toRemove.push(edge.id);
        state.currentEdges.delete(edge.id);
      }
    });
    state.edges.remove(toRemove);
  }

  function refreshAllEdges() {
    state.edges.clear();
    state.currentEdges.clear();
    state.activeNodes.forEach(nid => addEdgesFor(nid));
  }

  // ── Strain Detail Panel ──
  async function loadStrainDetail(strainName) {
    const panel = document.getElementById('strain-panel');
    panel.innerHTML = `<div class="empty-state"><div class="loading-spinner"></div><div>Loading...</div></div>`;

    try {
      const resp = await fetch(`/api/strains/${encodeURIComponent(strainName)}/detail`);
      if (!resp.ok) throw new Error('Not found');
      const d = await resp.json();
      panel.innerHTML = renderStrainCard(d);
    } catch {
      // Fallback for strains with no sample data
      const node = state.nodes.get(strainName);
      panel.innerHTML = renderBasicCard(strainName, node);
    }
  }

  function renderStrainCard(d) {
    let html = `<div class="strain-card">
      <h2>${(d.name || '').replace(/_/g, ' ')}</h2>
      ${d.rsp ? `<span class="rsp-badge">${d.rsp}</span>` : ''}`;

    // Metadata
    if (d.metadata && Object.values(d.metadata).some(v => v)) {
      html += `<div class="card-section"><h3>General Information</h3><div class="meta-grid">`;
      const fields = [
        ['Grower', d.metadata.grower],
        ['Sex', d.metadata.reported_sex],
        ['Type', d.metadata.plant_type],
        ['Rarity', d.metadata.rarity],
        ['Report', d.metadata.report_type],
        ['Accession', d.metadata.accession_date],
      ];
      fields.forEach(([label, val]) => {
        if (val) html += `<div class="meta-item"><div class="label">${label}</div><div class="value">${val}</div></div>`;
      });
      if (d.metadata.heterozygosity != null) {
        html += `<div class="meta-item"><div class="label">Heterozygosity</div><div class="value">${d.metadata.heterozygosity}%</div></div>`;
      }
      html += `</div></div>`;
    }

    // Cannabinoids
    if (d.cannabinoids && Object.keys(d.cannabinoids).length) {
      html += `<div class="card-section"><h3>Cannabinoids</h3>`;
      if (d.total_thc != null) html += `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">Total THC: <strong style="color:var(--accent-cyan)">${d.total_thc.toFixed(2)}%</strong></div>`;
      Object.entries(d.cannabinoids).forEach(([name, val]) => {
        const pct = Math.min(val / 30 * 100, 100);
        html += `<div class="chem-bar-wrap">
          <div class="chem-bar-label"><span class="name">${name}</span><span class="val">${val.toFixed(2)}%</span></div>
          <div class="chem-bar"><div class="chem-bar-fill cannabinoid" style="width:${pct}%"></div></div>
        </div>`;
      });
      html += `</div>`;
    }

    // Terpenes
    if (d.terpenes && Object.keys(d.terpenes).length) {
      html += `<div class="card-section"><h3>Terpene Profile</h3>`;
      const sorted = Object.entries(d.terpenes).sort((a, b) => b[1] - a[1]);
      const maxTerp = sorted[0] ? sorted[0][1] : 1;
      sorted.forEach(([name, val]) => {
        const pct = Math.min(val / Math.max(maxTerp, 0.5) * 100, 100);
        html += `<div class="chem-bar-wrap">
          <div class="chem-bar-label"><span class="name">${name}</span><span class="val">${val.toFixed(3)}%</span></div>
          <div class="chem-bar"><div class="chem-bar-fill terpene" style="width:${pct}%"></div></div>
        </div>`;
      });
      html += `</div>`;
    }

    // Genetic neighbors
    const neighbors = state.relType === 'terpene' ? d.terpene_neighbors : d.genetic_neighbors;
    if (neighbors && neighbors.length) {
      html += `<div class="card-section"><h3>${capitalize(state.relType)} Neighbors</h3><ul class="neighbor-list">`;
      neighbors.slice(0, 15).forEach(n => {
        html += `<li class="neighbor-item" data-strain="${n.strain}">
          <span>${(n.strain || '').replace(/_/g, ' ')}</span>
          <span class="dist">${n.distance.toFixed(3)}</span>
        </li>`;
      });
      html += `</ul></div>`;
    }

    // Blockchain
    if (d.blockchain && d.blockchain.txid) {
      html += `<div class="card-section"><h3>Blockchain Provenance</h3>
        <div class="meta-item" style="margin-bottom:6px"><div class="label">TX ID</div><div class="value" style="font-size:11px;word-break:break-all">${d.blockchain.txid}</div></div>
        ${d.blockchain.shasum ? `<div class="meta-item"><div class="label">SHASUM</div><div class="value" style="font-size:11px;word-break:break-all">${d.blockchain.shasum}</div></div>` : ''}
      </div>`;
    }

    html += `</div>`;
    return html;
  }

  function renderBasicCard(name, node) {
    return `<div class="strain-card">
      <h2>${(name || '').replace(/_/g, ' ')}</h2>
      ${node && node.rsp ? `<span class="rsp-badge">${node.rsp}</span>` : ''}
      <div class="card-section">
        <div class="meta-item"><div class="label">Status</div><div class="value">${node && node.complete ? 'Complete' : 'Incomplete — needs scraping'}</div></div>
      </div>
    </div>`;
  }

  // ── Event Bindings ──
  function bindEvents() {
    // Search
    const searchInput = document.getElementById('search-input');
    let searchTimeout;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => performSearch(searchInput.value), 200);
    });

    // View tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // Relation toggle
    document.querySelectorAll('.rel-btn').forEach(btn => {
      btn.addEventListener('click', () => switchRelation(btn.dataset.rel));
    });

    // Graph controls
    document.getElementById('btn-zoom-in').addEventListener('click', () =>
      state.network.moveTo({ scale: state.network.getScale() * 1.3, animation: true }));
    document.getElementById('btn-zoom-out').addEventListener('click', () =>
      state.network.moveTo({ scale: state.network.getScale() * 0.7, animation: true }));
    document.getElementById('btn-fit').addEventListener('click', () =>
      state.network.fit({ animation: { duration: 400 } }));
    document.getElementById('btn-physics').addEventListener('click', togglePhysics);

    // Neighbor click delegation
    document.getElementById('strain-panel').addEventListener('click', e => {
      const item = e.target.closest('.neighbor-item');
      if (item) {
        const name = item.dataset.strain;
        state.network.focus(name, { scale: 1.2, animation: { duration: 400 } });
        if (!state.activeNodes.has(name)) {
          handleNodeClick(name);
        } else {
          loadStrainDetail(name);
        }
      }
    });
  }

  // ── Search ──
  function performSearch(term) {
    const lower = term.toLowerCase().trim();
    if (!lower) {
      state.nodes.get().forEach(n => state.nodes.update({ id: n.id, opacity: 1 }));
      return;
    }
    state.nodes.get().forEach(n => {
      const match = n.label.toLowerCase().includes(lower);
      state.nodes.update({ id: n.id, opacity: match ? 1 : 0.15 });
    });
  }

  // ── View Switching ──
  function switchView(view) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.tab-btn[data-view="${view}"]`).classList.add('active');
    state.currentView = view;

    const container = document.getElementById('graph-container');

    if (view === 'network') {
      container.innerHTML = '';
      buildGraph();
    } else if (view === 'tree') {
      renderPhyloTree(container);
    } else if (view === 'full-tree') {
      container.innerHTML = '';
      if (typeof renderFullPhylogeneticTree === 'function') {
        renderFullPhylogeneticTree(container, state.nodes, state.allRelationships);
      }
    }
  }

  function renderPhyloTree(container) {
    container.innerHTML = '';
    if (state.activeNodes.size === 0) {
      container.innerHTML = '<div class="empty-state" style="height:100%"><div class="icon">🌳</div><div>Select nodes in Network view first</div></div>';
      return;
    }

    const treeNodes = new vis.DataSet();
    const treeEdges = new vis.DataSet();
    const processed = new Set();
    const processedEdges = new Set();

    function addNode(nodeId, level) {
      if (level >= 3 || processed.has(nodeId)) return;
      const node = state.nodes.get(nodeId);
      if (!node) return;
      processed.add(nodeId);

      treeNodes.add({
        id: `${nodeId}_${level}`, label: node.label, level,
        color: { background: level === 0 ? COLORS.selected.bg : COLORS.complete.bg, border: level === 0 ? COLORS.selected.border : COLORS.complete.border },
        size: 20, font: { color: '#e8e8f0', strokeWidth: 2, strokeColor: '#0a0a14', size: 13 },
      });

      const rels = state.allRelationships
        .filter(r => (r.from === nodeId || r.to === nodeId) && r.distance < 0.5 && state.nodes.get(r.from === nodeId ? r.to : r.from))
        .sort((a, b) => a.distance - b.distance).slice(0, 4);

      rels.forEach(rel => {
        const childId = rel.from === nodeId ? rel.to : rel.from;
        if (!processed.has(childId)) {
          const ek = [nodeId, childId].sort().join('_');
          if (!processedEdges.has(ek)) {
            processedEdges.add(ek);
            treeEdges.add({
              id: `e_${ek}_${level}`, from: `${nodeId}_${level}`, to: `${childId}_${level + 1}`,
              width: 2, color: { color: COLORS.genetic.edge, opacity: 0.6 },
              title: `Distance: ${rel.distance.toFixed(3)}`,
            });
            addNode(childId, level + 1);
          }
        }
      });
    }

    state.activeNodes.forEach(nid => addNode(nid, 0));

    new vis.Network(container, { nodes: treeNodes, edges: treeEdges }, {
      physics: false,
      layout: { hierarchical: { enabled: true, direction: 'LR', sortMethod: 'directed', levelSeparation: 140, nodeSpacing: 100 } },
      interaction: { dragNodes: false, dragView: true, zoomView: true, hover: true },
    });
  }

  // ── Relation Switching ──
  function switchRelation(rel) {
    state.relType = rel;
    document.querySelectorAll('.rel-btn').forEach(b => {
      b.className = 'rel-btn';
    });
    document.querySelector(`.rel-btn[data-rel="${rel}"]`).classList.add(`active-${rel}`);
    refreshAllEdges();

    // Re-render detail panel if a strain is selected
    if (state.activeNodes.size > 0) {
      const last = Array.from(state.activeNodes).pop();
      loadStrainDetail(last);
    }
  }

  // ── Physics Toggle ──
  function togglePhysics() {
    state.physicsOn = !state.physicsOn;
    state.network.setOptions({
      physics: {
        enabled: state.physicsOn,
        stabilization: { enabled: true, iterations: 100 },
        repulsion: { nodeDistance: 200, centralGravity: 0.08, springLength: 280, springConstant: 0.04, damping: 0.09 },
      },
    });
    document.getElementById('btn-physics').classList.toggle('active', state.physicsOn);
  }

  // ── Utils ──
  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
  }

})();
