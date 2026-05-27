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
    allLineageRels: [],
    activeNodes: new Set(),
    currentEdges: new Set(),
    relType: 'genetic',   // 'genetic' | 'terpene' | 'lineage' | 'combined'
    currentView: 'network',
    physicsOn: false,
  };

  // ── Color palette ──
  const COLORS = {
    genetic:  { edge: '#00d2ff', bg: 'rgba(0,210,255,0.12)', node: '#3a7bd5' },
    terpene:  { edge: '#00c853', bg: 'rgba(0,200,83,0.12)',  node: '#7cb342' },
    combined: { edge: '#e040fb', bg: 'rgba(224,64,251,0.12)', node: '#9c27b0' },
    lineage:  { edge: '#ffb300', bg: 'rgba(255,179,0,0.12)',  node: '#ff8f00' },
    complete: { bg: '#3a7bd5', border: '#5c9ce6' },
    incomplete: { bg: '#333348', border: '#555568' },
    selected: { bg: '#ef5350', border: '#ff7043' },
    
    // Source specific colors
    kannapedia: {
      complete: { bg: '#3a7bd5', border: '#5c9ce6' }, // Blue
      incomplete: { bg: '#333348', border: '#555568' } // Grey
    },
    seedfinder: {
      complete: { bg: '#2e7d32', border: '#4caf50' }, // Green
      incomplete: { bg: '#1b5e20', border: '#2e7d32' } // Dark Green
    },
    forum: {
      complete: { bg: '#7b1fa2', border: '#9c27b0' }, // Purple
      incomplete: { bg: '#4a148c', border: '#7b1fa2' } // Dark Purple
    },
    manual: {
      complete: { bg: '#ef6c00', border: '#ff9800' }, // Orange
      incomplete: { bg: '#5d4037', border: '#ef6c00' } // Brown/Orange
    }
  };

  // ── Physics Configuration ──
  const CALM_PHYSICS = {
    enabled: true,
    solver: 'barnesHut',
    barnesHut: {
      gravitationalConstant: -2000,
      centralGravity: 0.1,
      springLength: 150,
      springConstant: 0.015,
      damping: 0.5,
      avoidOverlap: 0.8
    },
    maxVelocity: 15,
    minVelocity: 0.1,
    timestep: 0.35,
    stabilization: {
      enabled: true,
      iterations: 200,
      updateInterval: 25
    }
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
      state.allLineageRels = data.lineageRelationships || [];
      console.log('Nodes loaded:', state.allNodes.length);
      console.log('Genetic relationships loaded:', state.allRelationships.length);
      console.log('Terpene relationships loaded:', state.allTerpeneRels.length);
      console.log('Lineage relationships loaded:', state.allLineageRels.length);
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
    const nodeData = state.allNodes.map(n => {
      const src = n.source || 'kannapedia';
      const isComplete = n.complete;
      const palette = COLORS[src] || COLORS.kannapedia;
      const nodeColors = isComplete ? palette.complete : palette.incomplete;
      
      const hoverBg = isComplete ? '#4a8ce8' : '#444460';
      const hoverBorder = isComplete ? '#6eaaff' : '#666680';
      
      const isActive = state.activeNodes.has(n.id);
      const bg = isActive ? COLORS.selected.bg : nodeColors.bg;
      const border = isActive ? COLORS.selected.border : nodeColors.border;

      return {
        id: n.id,
        label: (n.label || n.id).replace(/_/g, ' '),
        title: `${(n.label||n.id).replace(/_/g,' ')}\nRSP: ${n.rsp || '—'}\nSource: ${capitalize(src)}\n${isComplete ? 'Complete data' : 'Incomplete'}`,
        color: {
          background: bg,
          border: border,
          highlight: { background: COLORS.selected.bg, border: COLORS.selected.border },
          hover: { background: hoverBg, border: hoverBorder },
        },
        font: { color: '#e8e8f0', strokeWidth: 2, strokeColor: '#0a0a14', size: 13 },
        rsp: n.rsp,
        complete: isComplete,
        source: src,
        size: isComplete ? 18 : 12,
        borderWidth: 2,
        shadow: { enabled: true, color: 'rgba(0,0,0,0.5)', size: 8 },
      };
    });

    state.nodes = new vis.DataSet(nodeData);
    state.edges = new vis.DataSet([]);

    // Populate all edges initially before creating the network to allow clustering
    refreshAllEdges();

    state.network = new vis.Network(container, {
      nodes: state.nodes,
      edges: state.edges,
    }, {
      nodes: { shape: 'dot' },
      edges: { width: 1.5, smooth: { type: 'continuous' }, color: { opacity: 0.5 } },
      layout: { improvedLayout: false, randomSeed: 42 },
      physics: CALM_PHYSICS,
      interaction: { hover: true, tooltipDelay: 200, zoomView: true, dragView: true, hideEdgesOnDrag: true, hideEdgesOnZoom: true },
    });

    // Disable physics after stabilization
    state.network.once('stabilizationIterationsDone', () => {
      state.network.setOptions({ physics: { enabled: false } });
      state.physicsOn = false;
    });

    // Click on node or background
    state.network.on('click', params => {
      if (params.nodes.length > 0) {
        handleNodeClick(params.nodes[0]);
      } else {
        state.activeNodes.clear();
        resetHighlighting();
      }
    });
  }

  // ── Node Click ──
  function handleNodeClick(nodeId) {
    const node = state.nodes.get(nodeId);
    if (!node) return;

    // Toggle active
    if (state.activeNodes.has(nodeId)) {
      state.activeNodes.clear();
      resetHighlighting();
    } else {
      activateNode(nodeId);
    }

    // Load detail
    loadStrainDetail(nodeId);
  }

  function activateNode(nodeId) {
    if (!nodeId) return;
    const node = state.nodes ? state.nodes.get(nodeId) : null;
    if (!node) return;

    state.activeNodes.clear();
    state.activeNodes.add(nodeId);
    highlightNeighborhood(nodeId);
  }

  // ── Edge Management & Neighborhood Highlighting ──
  function relForEdgeId(eid) {
    const parts = eid.split('|');
    const from = parts[0];
    const to = parts[1];
    const type = parts[2];
    const pool = type === 'genetic' ? state.allRelationships : state.allTerpeneRels;
    return pool.find(r => (r.from === from && r.to === to) || (r.from === to && r.to === from));
  }

  function highlightNeighborhood(nodeId) {
    if (!nodeId) {
      resetHighlighting();
      return;
    }

    const connectedNodes = new Set();
    connectedNodes.add(nodeId);

    const connectedEdges = new Set();

    // Find all edges connected to nodeId
    state.edges.forEach(edge => {
      if (edge.from === nodeId || edge.to === nodeId) {
        connectedEdges.add(edge.id);
        connectedNodes.add(edge.from);
        connectedNodes.add(edge.to);
      }
    });

    // Update nodes opacity and size
    const nodeUpdates = [];
    state.nodes.forEach(node => {
      const isConnected = connectedNodes.has(node.id);
      const isTarget = node.id === nodeId;
      
      const src = node.source || 'kannapedia';
      const isComplete = node.complete;
      const palette = COLORS[src] || COLORS.kannapedia;
      const nodeColors = isComplete ? palette.complete : palette.incomplete;
      
      const bg = isTarget ? COLORS.selected.bg : nodeColors.bg;
      const border = isTarget ? COLORS.selected.border : nodeColors.border;

      nodeUpdates.push({
        id: node.id,
        color: {
          background: bg,
          border: border,
          highlight: { background: COLORS.selected.bg, border: COLORS.selected.border },
        },
        opacity: isConnected ? 1.0 : 0.15,
        size: isTarget ? 22 : (isConnected ? (isComplete ? 18 : 12) : (isComplete ? 12 : 8)),
        font: {
          color: isConnected ? '#e8e8f0' : 'rgba(232, 232, 240, 0.25)',
        }
      });
    });
    state.nodes.update(nodeUpdates);

    // Update edges opacity and width
    const edgeUpdates = [];
    state.edges.forEach(edge => {
      const isConnected = connectedEdges.has(edge.id);
      const parts = edge.id.split('|');
      const type = parts[parts.length - 1];
      const rel = relForEdgeId(edge.id);
      const distance = rel ? rel.distance : 0.5;
      
      edgeUpdates.push({
        id: edge.id,
        color: {
          color: COLORS[type].edge,
          opacity: isConnected ? Math.max(0.5, 1 - distance) : 0.02
        },
        width: isConnected ? Math.max(1.5, 4 * (1 - distance)) : 0.5
      });
    });
    state.edges.update(edgeUpdates);
  }

  function resetHighlighting() {
    if (!state.nodes) return;
    const nodeUpdates = [];
    state.nodes.forEach(node => {
      const src = node.source || 'kannapedia';
      const isComplete = node.complete;
      const palette = COLORS[src] || COLORS.kannapedia;
      const nodeColors = isComplete ? palette.complete : palette.incomplete;

      nodeUpdates.push({
        id: node.id,
        color: {
          background: nodeColors.bg,
          border: nodeColors.border,
          highlight: { background: COLORS.selected.bg, border: COLORS.selected.border },
        },
        opacity: 1.0,
        size: isComplete ? 18 : 12,
        font: {
          color: '#e8e8f0',
        }
      });
    });
    state.nodes.update(nodeUpdates);

    if (!state.edges) return;
    const edgeUpdates = [];
    state.edges.forEach(edge => {
      const parts = edge.id.split('|');
      const type = parts[parts.length - 1];
      const rel = relForEdgeId(edge.id);
      const distance = rel ? rel.distance : 0.5;
      
      edgeUpdates.push({
        id: edge.id,
        color: {
          color: COLORS[type].edge,
          opacity: Math.max(0.1, (1 - distance) * 0.4)
        },
        width: Math.max(0.5, 2 * (1 - distance))
      });
    });
    state.edges.update(edgeUpdates);
  }

  function refreshAllEdges() {
    state.edges.clear();
    state.currentEdges.clear();
    
    // Determine pool of relationships to use
    let rels = [];
    if (state.relType === 'genetic') {
      rels = state.allRelationships.map(r => ({ ...r, type: 'genetic' }));
    } else if (state.relType === 'terpene') {
      rels = state.allTerpeneRels.map(r => ({ ...r, type: 'terpene' }));
    } else if (state.relType === 'lineage') {
      rels = state.allLineageRels.map(r => ({ ...r, type: 'lineage' }));
    } else { // combined
      const gen = state.allRelationships.map(r => ({ ...r, type: 'genetic' }));
      const terp = state.allTerpeneRels.map(r => ({ ...r, type: 'terpene' }));
      const lin = state.allLineageRels.map(r => ({ ...r, type: 'lineage' }));
      rels = [...gen, ...terp, ...lin];
    }

    const edgesMap = new Map();

    // Add edges to DataSet
    rels.forEach(rel => {
      const type = rel.type;
      const edgeColor = COLORS[type].edge;
      const titlePrefix = type === 'genetic' ? 'Genetic' : (type === 'lineage' ? 'Lineage' : 'Terpene');
      const eid = [rel.from, rel.to].sort().join('|') + `|${type}`;
      
      // Filter out extremely weak connections to keep the graph clean,
      // but always allow top 5 closest terpene connections.
      const maxDist = type === 'genetic' ? 0.35 : (type === 'lineage' ? 1.0 : 0.5);
      if (rel.distance <= maxDist || rel.is_top_5 || rel.guaranteed || type === 'lineage') {
        const value = 1 - rel.distance;
        if (edgesMap.has(eid)) {
          const existing = edgesMap.get(eid);
          if (value > existing.value) {
            existing.value = value;
            existing.length = rel.distance * 350;
            existing.title = `${titlePrefix} Distance: ${rel.distance.toFixed(3)}`;
            existing.color = { color: edgeColor, opacity: Math.max(0.1, value * 0.4) };
            existing.width = Math.max(0.5, 2 * value);
          }
          return;
        }

        const newEdge = {
          id: eid,
          from: rel.from,
          to: rel.to,
          value: value,
          length: rel.distance * 350,
          title: `${titlePrefix} Distance: ${rel.distance.toFixed(3)}`,
          color: { color: edgeColor, opacity: Math.max(0.1, value * 0.4) },
          width: Math.max(0.5, 2 * value),
        };
        edgesMap.set(eid, newEdge);
        state.currentEdges.add(eid);
      }
    });

    if (edgesMap.size > 0) {
      state.edges.add(Array.from(edgesMap.values()));
    }

    // If there is an active node, apply the highlight immediately
    if (state.activeNodes.size > 0) {
      const activeNodeId = Array.from(state.activeNodes)[0];
      highlightNeighborhood(activeNodeId);
    }
  }


  // ── Strain Detail Panel ──
  async function loadStrainDetail(strainName, source, strainSlug, breederSlug, realName, force = false) {
    state.currentStrainData = null;
    const panel = document.getElementById('strain-panel');
    panel.innerHTML = `<div class="empty-state"><div class="loading-spinner"></div><div>Loading...</div></div>`;

    try {
      let resp;
      const isImport = (source === 'seedfinder' || source === 'forum' || source === 'free-text') || force;
      if (isImport) {
        const useSource = source || (breederSlug === 'forum-import' ? 'forum' : 'seedfinder');
        const useRealName = realName || strainName;
        const useStrainSlug = strainSlug || strainName.toLowerCase().replace(/ /g, '-').replace(/_/g, '-');
        const useBreederSlug = breederSlug || 'forum-import';

        panel.innerHTML = `
          <div class="import-progress-card">
            <h3>Importing ${useRealName}</h3>
            <div class="import-progress-status" id="import-status">Initializing...</div>
            <div class="import-progress-bar-wrap">
              <div class="import-progress-bar" id="import-bar" style="width: 0%"></div>
            </div>
            <div class="import-progress-details">
              <div class="progress-stat">
                <span class="stat-label">Posts Collected</span>
                <span class="stat-value" id="progress-posts-count">0</span>
              </div>
              <div class="progress-stat">
                <span class="stat-label">Images Collected</span>
                <span class="stat-value" id="progress-images-count">0</span>
              </div>
            </div>
          </div>
        `;

        function estimateProgress(message) {
          if (!message) return 0;
          const msg = message.toLowerCase();
          if (msg.includes("initializing")) return 5;
          if (msg.includes("fetching metadata")) return 10;
          if (msg.includes("scraping overgrow")) return 20;
          if (msg.includes("overgrow complete") || msg.includes("scraping rollitup")) return 35;
          if (msg.includes("rollitup thread")) {
            const match = msg.match(/thread\s+(\d+)\/(\d+)/);
            if (match) {
              const current = parseInt(match[1]);
              const total = parseInt(match[2]);
              return 35 + Math.round((current / total) * 15);
            }
            return 45;
          }
          if (msg.includes("rollitup complete") || msg.includes("scraping thcfarmer")) return 50;
          if (msg.includes("thcfarmer thread")) {
            const match = msg.match(/thread\s+(\d+)\/(\d+)/);
            if (match) {
              const current = parseInt(match[1]);
              const total = parseInt(match[2]);
              return 50 + Math.round((current / total) * 15);
            }
            return 60;
          }
          if (msg.includes("thcfarmer complete") || msg.includes("scraping icmag")) return 65;
          if (msg.includes("icmag thread")) {
            const match = msg.match(/thread\s+(\d+)\/(\d+)/);
            if (match) {
              const current = parseInt(match[1]);
              const total = parseInt(match[2]);
              return 65 + Math.round((current / total) * 20);
            }
            return 75;
          }
          return 90;
        }

        const importPayload = {
          strain_slug: useStrainSlug,
          breeder_slug: useBreederSlug,
          force: force
        };
        if (source === 'free-text') {
          importPayload.query = strainName;
        }

        resp = await fetch('/api/strains/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(importPayload)
        });

        if (!resp.ok) {
          throw new Error('Failed to start import');
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let finalData = null;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const packet = JSON.parse(line);
              if (packet.type === 'progress') {
                const statusEl = document.getElementById('import-status');
                const barEl = document.getElementById('import-bar');
                const postsEl = document.getElementById('progress-posts-count');
                const imagesEl = document.getElementById('progress-images-count');
                
                if (statusEl) statusEl.textContent = packet.message;
                if (postsEl) postsEl.textContent = packet.posts || 0;
                if (imagesEl) imagesEl.textContent = packet.images || 0;
                
                if (barEl) {
                  const pct = estimateProgress(packet.message);
                  barEl.style.width = `${pct}%`;
                }
              } else if (packet.type === 'done') {
                finalData = packet.data;
              } else if (packet.type === 'error') {
                throw new Error(packet.error || 'Import failed');
              }
            } catch (err) {
              console.error('Failed to parse NDJSON line:', err);
              if (err.message.includes('Import failed') || err.message.includes('Failed to start import')) {
                throw err;
              }
            }
          }
        }

        if (!finalData) {
          throw new Error('Import did not complete successfully');
        }

        // Render final strain card
        state.currentStrainData = finalData;
        panel.innerHTML = renderStrainCard(finalData);
        if (typeof renderLineageTree === 'function') {
          renderLineageTree(finalData.name, finalData.lineage);
        }

        // Trigger a reload of network data so the newly imported strain node appears in the visualization
        try {
          const ndResp = await fetch('/api/network-data');
          if (ndResp.ok) {
            const ndData = await ndResp.json();
            state.allNodes = ndData.nodes || [];
            state.allRelationships = ndData.relationships || [];
            state.allTerpeneRels = ndData.terpeneRelationships || [];
            console.log('Nodes loaded after import:', state.allNodes.length);
            console.log('Genetic relationships loaded after import:', state.allRelationships.length);
            console.log('Terpene relationships loaded after import:', state.allTerpeneRels.length);
            renderStats();
            if (state.currentView === 'network') {
              buildGraph();
               // Try to select and activate the node
              const targetNodeId = finalData.name;
              if (state.nodes && state.nodes.get(targetNodeId) && state.network) {
                state.network.selectNodes([targetNodeId]);
                state.network.focus(targetNodeId, { scale: 1.5, animation: true });
                activateNode(targetNodeId);
              }
            }
          }
        } catch (ndErr) {
          console.error('Failed to update network graph:', ndErr);
        }

      } else {
        resp = await fetch(`/api/strains/${encodeURIComponent(strainName)}/detail`);
        if (!resp.ok) throw new Error('Not found');
        const d = await resp.json();
        state.currentStrainData = d;
        panel.innerHTML = renderStrainCard(d);
        if (typeof renderLineageTree === 'function') {
          renderLineageTree(d.name, d.lineage);
        }

        // Focus and activate in graph if view is network
        if (state.currentView === 'network' && state.nodes && state.nodes.get(d.name) && state.network) {
          state.network.selectNodes([d.name]);
          activateNode(d.name);
        }
      }
    } catch (err) {
      // Fallback for strains with no sample data
      console.error('loadStrainDetail error:', err);
      const node = state.nodes ? state.nodes.get(strainName) : null;
      panel.innerHTML = renderBasicCard(strainName, node);
      if (typeof renderLineageTree === 'function') {
        renderLineageTree(strainName, null);
      }
    }
  }



  function cleanImageUrl(url) {
    if (!url) return '';
    if (url.includes('proxy.php?image=')) {
      try {
        const urlObj = new URL(url);
        const originalUrl = urlObj.searchParams.get('image');
        if (originalUrl) {
          return decodeURIComponent(originalUrl);
        }
      } catch (e) {
        const match = url.match(/[?&]image=([^&]+)/);
        if (match) {
          return decodeURIComponent(match[1]);
        }
      }
    }
    return url;
  }

  function renderStrainCard(d) {
    let badgeText = '🧬 Kannapedia WGS Data';
    let badgeClass = 'kannapedia';
    if (d.source === 'seedfinder') {
      badgeText = '🌱 SeedFinder Lineage';
      badgeClass = 'seedfinder';
    } else if (d.source === 'forum') {
      badgeText = '💬 Forum Observation';
      badgeClass = 'forum';
    } else if (d.source === 'manual') {
      badgeText = '✍️ Manual Entry';
      badgeClass = 'manual';
    }

    let html = `<div class="strain-card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap: 10px; flex-wrap: wrap;">
        <h2 style="margin:0">${(d.name || '').replace(/_/g, ' ')}</h2>
        ${d.strain_slug && d.breeder_slug ? `
          <button class="rescraped-btn" data-strain-slug="${escapeHtml(d.strain_slug)}" data-breeder-slug="${escapeHtml(d.breeder_slug)}" data-real-name="${escapeHtml(d.name)}" style="background:rgba(0, 242, 254, 0.1); border:1px solid var(--accent-cyan); color:var(--accent-cyan); padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer; font-weight:600; transition:all 0.2s;">
            🔄 Re-scrape & Reset Cache
          </button>
        ` : ''}
      </div>
      <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:14px; align-items:center;">
        ${d.rsp ? `<span class="rsp-badge">${d.rsp}</span>` : `<span class="rsp-badge community">Community Data Only</span>`}
        <span class="rsp-badge ${badgeClass}">${badgeText}</span>
      </div>`;

    if (!d.rsp) {
      html += `<div class="community-notice-box">
        <div class="community-notice-title">
          <span>⚠️</span> Community Data Only
        </div>
        <div>
          This strain is not registered in the Kannapedia genomic database. DNA sequencing, cannabinoid, and terpene profiles are unavailable. Displaying forum observations and SeedFinder lineage details instead.
        </div>
      </div>`;
    }

    // Strain-level info (breeder, type, description) — always available
    html += `<div class="card-section">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <h3 style="margin:0">Strain Information</h3>
        <button class="edit-strain-btn" data-strain-name="${escapeHtml(d.name)}" style="background:rgba(0, 242, 254, 0.1); border:1px solid var(--accent-cyan); color:var(--accent-cyan); padding:2px 6px; border-radius:4px; font-size:11px; cursor:pointer; font-weight:600; transition:all 0.2s;">
          ✏️ Edit Info
        </button>
      </div>
      <div class="meta-grid">`;
    if (d.breeder) html += `<div class="meta-item"><div class="label">Breeder</div><div class="value">${d.breeder}</div></div>`;
    if (d.strain_type) html += `<div class="meta-item"><div class="label">Type</div><div class="value">${d.strain_type}</div></div>`;
    if (d.avg_flowering_days) html += `<div class="meta-item"><div class="label">Flowering</div><div class="value">${d.avg_flowering_days} days</div></div>`;
    html += `</div>`;
    if (d.description) {
      if (d.translated_description) {
        html += `<div class="description-wrap" style="margin-top:8px">
          <p class="desc-translated" style="color:var(--text-secondary);font-size:13px;line-height:1.5;font-style:italic">
            ${escapeHtml(d.translated_description)}
          </p>
          <p class="desc-original" style="display:none;color:var(--text-secondary);font-size:13px;line-height:1.5">
            ${escapeHtml(d.description)}
          </p>
          <button class="translate-toggle-btn" data-lang="${escapeHtml(d.detected_language || 'es')}" style="background:none;border:none;color:var(--accent-cyan);font-size:11px;font-weight:600;cursor:pointer;padding:4px 0;margin-top:4px;display:block">
            Auto-translated to English. Show original (${(d.detected_language || 'es').toUpperCase()})
          </button>
        </div>`;
      } else {
        html += `<p style="color:var(--text-secondary);font-size:13px;line-height:1.5;margin-top:8px">${escapeHtml(d.description)}</p>`;
      }
    }
    if (d.lineage) {
      let lineageText = '';
      if (Array.isArray(d.lineage)) {
        lineageText = d.lineage.map(p => typeof p === 'object' ? p.name : p).join(' × ');
      } else if (typeof d.lineage === 'object' && Object.keys(d.lineage).length > 0) {
        lineageText = Object.entries(d.lineage).map(([k, v]) => k + (v ? ': ' + v : '')).join(' × ');
      } else if (typeof d.lineage === 'string' && d.lineage.toLowerCase() !== 'unknown') {
        lineageText = d.lineage;
      }
      if (lineageText) {
        html += `<div style="margin-top:8px"><span style="color:var(--text-muted);font-size:11px">Lineage:</span> <span style="color:var(--text-secondary);font-size:12px">${lineageText}</span></div>`;
      }
    }

    // Cultivar Family Tree visual placeholder
    html += `<div class="card-section">
      <h3>Cultivar Family Tree</h3>
      <div class="family-tree-card" id="family-tree-card">
        <div class="empty-tree-state">Building family tree...</div>
      </div>
    </div>`;
    html += `</div>`;

    // Genomic sample metadata (from Kannapedia)
    if (d.metadata && Object.values(d.metadata).some(v => v)) {
      html += `<div class="card-section"><h3>Genomic Sample Data</h3><div class="meta-grid">`;
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

    // Plant Pictures Gallery (Clustered)
    if (d.observations && d.observations.some(obs => obs.images && obs.images.length)) {
      const allImages = [];
      d.observations.forEach(obs => {
        if (obs.images) {
          obs.images.forEach(img => {
            allImages.push({
              ...img,
              author: obs.author,
              source_name: obs.source_name,
              source_url: obs.source_url,
              observed_at: obs.observed_at,
            });
          });
        }
      });

      const clusters = {};
      allImages.forEach(img => {
        const cid = img.cluster_id || 'unclustered';
        if (!clusters[cid]) {
          clusters[cid] = [];
        }
        clusters[cid].push(img);
      });

      html += `<div class="card-section"><h3>Plant Pictures (Clustered)</h3>`;
      Object.entries(clusters).forEach(([clusterId, imgs]) => {
        const title = clusterId === 'unclustered' ? 'Unclustered' : `Cluster ${clusterId}`;
        html += `<div class="image-cluster-group">
          <div class="cluster-header">${title} (${imgs.length})</div>
          <div class="image-gallery-grid">`;
        imgs.forEach(img => {
          const cleanedUrl = cleanImageUrl(img.image_url);
          html += `<div class="gallery-image-card">
            <img src="${cleanedUrl}" alt="Strain image" onerror="this.src='https://images.unsplash.com/photo-1603909223429-69bb7101f420?w=300'" class="gallery-img" />
            <div class="img-meta">
              <span>By ${img.author || 'Anonymous'}</span>
              ${img.source_url ? `<a href="${img.source_url}" target="_blank" class="source-link-icon" title="View Source Post">🔗</a>` : ''}
            </div>
          </div>`;
        });
        html += `</div></div>`;
      });
      html += `</div>`;
    }

    // Grower Observations & Forum Notes (Enhanced & Expandable)
    if (d.observations && d.observations.length) {
      const counts = { all: d.observations.length };
      d.observations.forEach(obs => {
        const src = (obs.source_name || 'unknown').toLowerCase();
        counts[src] = (counts[src] || 0) + 1;
      });

      html += `<div class="card-section">
        <h3>Grow Reports & Observations</h3>
        <div class="obs-tabs-container" style="display:flex; gap:6px; margin-bottom:12px; flex-wrap:wrap;">
          <button class="obs-tab-btn active" data-source="all" style="background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); color:var(--text-primary); padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer; font-weight:600; transition:all 0.2s;">
            All (${counts.all})
          </button>`;
          
      Object.entries(counts).forEach(([src, count]) => {
        if (src === 'all') return;
        const displayName = src.charAt(0).toUpperCase() + src.slice(1);
        html += `<button class="obs-tab-btn" data-source="${src}" style="background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); color:var(--text-muted); padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer; font-weight:600; transition:all 0.2s;">
          ${escapeHtml(displayName)} (${count})
        </button>`;
      });
      html += `</div>`;

      d.observations.forEach((obs, idx) => {
        let text = obs.raw_text || '';
        const titleMatch = text.match(/^Title:\s*(.*?)\n\n/i);
        const title = titleMatch ? titleMatch[1] : '';
        text = text.replace(/^Title:.*?\n\n/i, '').trim();
        
        const isLong = text.length > 200;
        const shortText = isLong ? text.substring(0, 200) + '...' : text;
        
        const escapedFull = escapeHtml(text);
        const escapedShort = escapeHtml(shortText);
        const displayDate = obs.observed_at ? new Date(obs.observed_at).toLocaleDateString() : '';
        const srcLower = (obs.source_name || 'unknown').toLowerCase();
        
        html += `<div class="observation-quote-card" data-source="${srcLower}">
          <div class="observation-header">
            <span class="observation-title">${escapeHtml(title || 'Observation Note')}</span>
            <span class="observation-date">${displayDate}</span>
          </div>
          <blockquote class="observation-quote" id="obs-text-${idx}" data-full="${escapedFull}" data-short="${escapedShort}">"${isLong ? escapedShort : escapedFull}"</blockquote>
          ${isLong ? `<button class="expand-btn" data-idx="${idx}">Show More</button>` : ''}
          <div class="quote-footer">
            <span class="author">— ${escapeHtml(obs.author || 'Anonymous')}</span>
            <span class="source">via <span class="source-badge ${srcLower}">${escapeHtml(obs.source_name || 'Source')}</span> ${obs.source_url ? `<a href="${obs.source_url}" target="_blank" class="source-link-icon" title="View Source Post">🔗</a>` : ''}</span>
          </div>
        </div>`;
      });
      html += `</div>`;
    }

    // Genetic neighbors
    const neighbors = d.genetic_neighbors;
    if (neighbors && neighbors.length) {
      html += `<div class="card-section"><h3>Genetic Neighbors</h3><ul class="neighbor-list">`;
      neighbors.slice(0, 15).forEach(n => {
        html += `<li class="neighbor-item" data-strain="${n.strain}">
          <span>${(n.strain || '').replace(/_/g, ' ')}</span>
          <span class="dist">${n.distance.toFixed(3)}</span>
        </li>`;
      });
      html += `</ul></div>`;
    }

    // Terpene neighbors
    const tNeighbors = d.terpene_neighbors;
    if (tNeighbors && tNeighbors.length) {
      html += `<div class="card-section"><h3>Terpene Neighbors</h3><ul class="neighbor-list">`;
      tNeighbors.slice(0, 15).forEach(n => {
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
    const status = node && node.complete ? 'Complete' : 'Community data only — no genomic sample';
    return `<div class="strain-card">
      <h2>${(name || '').replace(/_/g, ' ')}</h2>
      ${node && node.rsp ? `<span class="rsp-badge">${node.rsp}</span>` : ''}
      <div class="card-section">
        <div class="meta-item"><div class="label">Status</div><div class="value">${status}</div></div>
      </div>
      <div class="card-section">
        <h3>Cultivar Family Tree</h3>
        <div class="family-tree-card" id="family-tree-card">
          <div class="empty-tree-state">Building family tree...</div>
        </div>
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

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(searchTimeout);
        const query = searchInput.value.trim();
        if (query) {
          const resultsEl = document.getElementById('search-results');
          if (resultsEl) {
            resultsEl.classList.remove('active');
            resultsEl.replaceChildren();
          }
          loadStrainDetail(query, 'free-text', query, 'free-text', query);
        }
      }
    });

    // View tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // Relation toggles
    document.querySelectorAll('.rel-btn').forEach(btn => {
      btn.addEventListener('click', () => switchRelType(btn.dataset.rel));
    });



    // Graph controls
    document.getElementById('btn-zoom-in').addEventListener('click', () =>
      state.network.moveTo({ scale: state.network.getScale() * 1.3, animation: true }));
    document.getElementById('btn-zoom-out').addEventListener('click', () =>
      state.network.moveTo({ scale: state.network.getScale() * 0.7, animation: true }));
    document.getElementById('btn-fit').addEventListener('click', () =>
      state.network.fit({ animation: { duration: 400 } }));
    document.getElementById('btn-physics').addEventListener('click', togglePhysics);

    // Click delegation for neighbor items and expand buttons
    document.getElementById('strain-panel').addEventListener('click', e => {
      const editBtn = e.target.closest('.edit-strain-btn');
      if (editBtn) {
        const strainName = editBtn.dataset.strainName;
        const d = state.currentStrainData;
        if (!d || d.name !== strainName) return;

        const infoSection = editBtn.closest('.card-section');
        const currentBreeder = d.breeder || '';
        const currentType = d.strain_type || '';
        const currentFlowering = d.avg_flowering_days || '';
        const currentDesc = d.description || '';
        let currentLineage = '';
        if (Array.isArray(d.lineage)) {
          currentLineage = d.lineage.map(p => typeof p === 'object' ? p.name : p).join(', ');
        } else if (typeof d.lineage === 'object' && Object.keys(d.lineage).length > 0) {
          currentLineage = Object.keys(d.lineage).join(', ');
        } else if (typeof d.lineage === 'string') {
          currentLineage = d.lineage;
        }

        const currentTHC = d.cannabinoids && d.cannabinoids.THC !== undefined ? d.cannabinoids.THC : '';
        const currentCBD = d.cannabinoids && d.cannabinoids.CBD !== undefined ? d.cannabinoids.CBD : '';
        
        const currentMyrcene = d.terpenes && d.terpenes.myrcene !== undefined ? d.terpenes.myrcene : '';
        const currentLimonene = d.terpenes && d.terpenes.limonene !== undefined ? d.terpenes.limonene : '';
        const currentCaryophyllene = d.terpenes && d.terpenes.caryophyllene !== undefined ? d.terpenes.caryophyllene : '';
        const currentPineneAlpha = d.terpenes && d.terpenes.pinene_alpha !== undefined ? d.terpenes.pinene_alpha : '';
        const currentPineneBeta = d.terpenes && d.terpenes.pinene_beta !== undefined ? d.terpenes.pinene_beta : '';
        const currentLinalool = d.terpenes && d.terpenes.linalool !== undefined ? d.terpenes.linalool : '';
        const currentHumulene = d.terpenes && d.terpenes.humulene !== undefined ? d.terpenes.humulene : '';
        const currentTerpinolene = d.terpenes && d.terpenes.terpinolene !== undefined ? d.terpenes.terpinolene : '';
        const currentOcimene = d.terpenes && d.terpenes.ocimene !== undefined ? d.terpenes.ocimene : '';

        infoSection.dataset.originalHtml = infoSection.innerHTML;

        infoSection.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px;">
            <h3 style="margin:0">Edit Strain Info</h3>
            <button class="cancel-edit-btn" style="background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:11px;">Cancel</button>
          </div>
          <form id="edit-strain-form" style="display:flex; flex-direction:column; gap:10px;">
            <div>
              <label style="display:block; font-size:11px; color:var(--text-muted); margin-bottom:4px;">Breeder</label>
              <input type="text" name="breeder" value="${escapeHtml(currentBreeder)}" style="width:100%; box-sizing: border-box; padding:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px;" />
            </div>
            <div>
              <label style="display:block; font-size:11px; color:var(--text-muted); margin-bottom:4px;">Type</label>
              <select name="strain_type" style="width:100%; box-sizing: border-box; padding:6px; background:#2a2a2a; border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px;">
                <option value="" ${currentType === '' ? 'selected' : ''}>Unknown</option>
                <option value="indica" ${currentType.toLowerCase() === 'indica' ? 'selected' : ''}>Indica</option>
                <option value="sativa" ${currentType.toLowerCase() === 'sativa' ? 'selected' : ''}>Sativa</option>
                <option value="hybrid" ${currentType.toLowerCase() === 'hybrid' ? 'selected' : ''}>Hybrid</option>
                <option value="mostly indica" ${currentType.toLowerCase() === 'mostly indica' ? 'selected' : ''}>Mostly Indica</option>
                <option value="mostly sativa" ${currentType.toLowerCase() === 'mostly sativa' ? 'selected' : ''}>Mostly Sativa</option>
              </select>
            </div>
            <div>
              <label style="display:block; font-size:11px; color:var(--text-muted); margin-bottom:4px;">Flowering Time (days)</label>
              <input type="number" name="avg_flowering_days" value="${currentFlowering}" style="width:100%; box-sizing: border-box; padding:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px;" />
            </div>
            <div>
              <label style="display:block; font-size:11px; color:var(--text-muted); margin-bottom:4px;">Parent Lineage (comma-separated)</label>
              <input type="text" name="lineage" value="${escapeHtml(currentLineage)}" placeholder="e.g. Blood Wreck, Querkle" style="width:100%; box-sizing: border-box; padding:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px;" />
            </div>
            <div>
              <label style="display:block; font-size:11px; color:var(--text-muted); margin-bottom:4px;">Description</label>
              <textarea name="description" rows="4" style="width:100%; box-sizing: border-box; padding:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px; resize:vertical;">${escapeHtml(currentDesc)}</textarea>
            </div>
            
            <div style="margin-top: 8px;">
              <h4 style="font-size:11px; font-weight:600; color:var(--text-secondary); margin-bottom: 6px; text-transform:uppercase;">Cannabinoids</h4>
              <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                <div>
                  <label style="display:block; font-size:10px; color:var(--text-muted); margin-bottom:2px;">THC %</label>
                  <input type="number" step="0.01" name="thc" value="${currentTHC}" style="width:100%; box-sizing: border-box; padding:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px;" />
                </div>
                <div>
                  <label style="display:block; font-size:10px; color:var(--text-muted); margin-bottom:2px;">CBD %</label>
                  <input type="number" step="0.01" name="cbd" value="${currentCBD}" style="width:100%; box-sizing: border-box; padding:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px;" />
                </div>
              </div>
            </div>
            
            <div style="margin-top: 8px;">
              <h4 style="font-size:11px; font-weight:600; color:var(--text-secondary); margin-bottom: 6px; text-transform:uppercase;">Terpenes (%)</h4>
              <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                <div>
                  <label style="display:block; font-size:10px; color:var(--text-muted); margin-bottom:2px;">Myrcene</label>
                  <input type="number" step="0.001" name="myrcene" value="${currentMyrcene}" style="width:100%; box-sizing: border-box; padding:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px;" />
                </div>
                <div>
                  <label style="display:block; font-size:10px; color:var(--text-muted); margin-bottom:2px;">Limonene</label>
                  <input type="number" step="0.001" name="limonene" value="${currentLimonene}" style="width:100%; box-sizing: border-box; padding:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px;" />
                </div>
                <div>
                  <label style="display:block; font-size:10px; color:var(--text-muted); margin-bottom:2px;">Caryophyllene</label>
                  <input type="number" step="0.001" name="caryophyllene" value="${currentCaryophyllene}" style="width:100%; box-sizing: border-box; padding:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px;" />
                </div>
                <div>
                  <label style="display:block; font-size:10px; color:var(--text-muted); margin-bottom:2px;">Pinene Alpha</label>
                  <input type="number" step="0.001" name="pinene_alpha" value="${currentPineneAlpha}" style="width:100%; box-sizing: border-box; padding:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px;" />
                </div>
                <div>
                  <label style="display:block; font-size:10px; color:var(--text-muted); margin-bottom:2px;">Pinene Beta</label>
                  <input type="number" step="0.001" name="pinene_beta" value="${currentPineneBeta}" style="width:100%; box-sizing: border-box; padding:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px;" />
                </div>
                <div>
                  <label style="display:block; font-size:10px; color:var(--text-muted); margin-bottom:2px;">Linalool</label>
                  <input type="number" step="0.001" name="linalool" value="${currentLinalool}" style="width:100%; box-sizing: border-box; padding:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px;" />
                </div>
                <div>
                  <label style="display:block; font-size:10px; color:var(--text-muted); margin-bottom:2px;">Humulene</label>
                  <input type="number" step="0.001" name="humulene" value="${currentHumulene}" style="width:100%; box-sizing: border-box; padding:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px;" />
                </div>
                <div>
                  <label style="display:block; font-size:10px; color:var(--text-muted); margin-bottom:2px;">Terpinolene</label>
                  <input type="number" step="0.001" name="terpinolene" value="${currentTerpinolene}" style="width:100%; box-sizing: border-box; padding:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px;" />
                </div>
                <div>
                  <label style="display:block; font-size:10px; color:var(--text-muted); margin-bottom:2px;">Ocimene</label>
                  <input type="number" step="0.001" name="ocimene" value="${currentOcimene}" style="width:100%; box-sizing: border-box; padding:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:var(--text-primary); font-size:12px;" />
                </div>
              </div>
            </div>
            
            <button type="submit" style="background:var(--accent-cyan); border:none; color:#000; padding:8px; border-radius:4px; font-weight:bold; font-size:12px; cursor:pointer; margin-top:4px;">Save Changes</button>
          </form>
        `;
        return;
      }

      const cancelBtn = e.target.closest('.cancel-edit-btn');
      if (cancelBtn) {
        const infoSection = cancelBtn.closest('.card-section');
        if (infoSection && infoSection.dataset.originalHtml) {
          infoSection.innerHTML = infoSection.dataset.originalHtml;
        }
        return;
      }

      const rescrapeBtn = e.target.closest('.rescraped-btn');
      if (rescrapeBtn) {
        const strainSlug = rescrapeBtn.dataset.strainSlug;
        const breederSlug = rescrapeBtn.dataset.breederSlug;
        const realName = rescrapeBtn.dataset.realName;
        loadStrainDetail(realName, breederSlug === 'forum-import' ? 'forum' : 'seedfinder', strainSlug, breederSlug, realName, true);
        return;
      }

      const item = e.target.closest('.neighbor-item');
      if (item) {
        const name = item.dataset.strain;
        state.network.focus(name, { scale: 1.2, animation: { duration: 400 } });
        if (!state.activeNodes.has(name)) {
          handleNodeClick(name);
        } else {
          loadStrainDetail(name);
        }
        return;
      }
      
      const expandBtn = e.target.closest('.expand-btn');
      if (expandBtn) {
        const card = expandBtn.closest('.observation-quote-card');
        const quote = card.querySelector('.observation-quote');
        const isExpanded = card.classList.toggle('expanded');
        
        if (isExpanded) {
          quote.textContent = `"${quote.dataset.full}"`;
          expandBtn.textContent = 'Show Less';
        } else {
          quote.textContent = `"${quote.dataset.short}"`;
          expandBtn.textContent = 'Show More';
        }
      }

      const obsTabBtn = e.target.closest('.obs-tab-btn');
      if (obsTabBtn) {
        const source = obsTabBtn.dataset.source;
        const card = obsTabBtn.closest('.card-section');
        card.querySelectorAll('.obs-tab-btn').forEach(btn => {
          btn.classList.remove('active');
          btn.style.color = 'var(--text-muted)';
        });
        obsTabBtn.classList.add('active');
        obsTabBtn.style.color = 'var(--text-primary)';
        
        card.querySelectorAll('.observation-quote-card').forEach(qCard => {
          if (source === 'all' || qCard.dataset.source === source) {
            qCard.style.display = 'block';
          } else {
            qCard.style.display = 'none';
          }
        });
        return;
      }

      const translateToggleBtn = e.target.closest('.translate-toggle-btn');
      if (translateToggleBtn) {
        const wrap = translateToggleBtn.closest('.description-wrap');
        const descTrans = wrap.querySelector('.desc-translated');
        const descOrig = wrap.querySelector('.desc-original');
        const lang = translateToggleBtn.dataset.lang || 'es';
        
        if (descTrans.style.display === 'none') {
          descTrans.style.display = 'block';
          descOrig.style.display = 'none';
          translateToggleBtn.textContent = `Auto-translated to English. Show original (${lang.toUpperCase()})`;
        } else {
          descTrans.style.display = 'none';
          descOrig.style.display = 'block';
          translateToggleBtn.textContent = 'Show English translation';
        }
      }
    });

    // Form submission delegation
    document.getElementById('strain-panel').addEventListener('submit', async e => {
      const form = e.target.closest('#edit-strain-form');
      if (!form) return;
      e.preventDefault();

      const strainName = state.currentStrainData ? state.currentStrainData.name : '';
      if (!strainName) return;

      const formData = new FormData(form);
      const breeder = formData.get('breeder');
      const strain_type = formData.get('strain_type');
      const avg_flowering_days = formData.get('avg_flowering_days');
      const description = formData.get('description');
      const lineageStr = formData.get('lineage');

      const lineage = lineageStr
        ? lineageStr.split(',').map(s => s.trim()).filter(Boolean)
        : [];

      const cannabinoids = {
        thc: formData.get('thc') ? parseFloat(formData.get('thc')) : null,
        cbd: formData.get('cbd') ? parseFloat(formData.get('cbd')) : null,
      };

      const terpenes = {
        myrcene: formData.get('myrcene') ? parseFloat(formData.get('myrcene')) : null,
        limonene: formData.get('limonene') ? parseFloat(formData.get('limonene')) : null,
        caryophyllene: formData.get('caryophyllene') ? parseFloat(formData.get('caryophyllene')) : null,
        pinene_alpha: formData.get('pinene_alpha') ? parseFloat(formData.get('pinene_alpha')) : null,
        pinene_beta: formData.get('pinene_beta') ? parseFloat(formData.get('pinene_beta')) : null,
        linalool: formData.get('linalool') ? parseFloat(formData.get('linalool')) : null,
        humulene: formData.get('humulene') ? parseFloat(formData.get('humulene')) : null,
        terpinolene: formData.get('terpinolene') ? parseFloat(formData.get('terpinolene')) : null,
        ocimene: formData.get('ocimene') ? parseFloat(formData.get('ocimene')) : null,
      };

      const payload = {
        breeder,
        strain_type,
        avg_flowering_days: avg_flowering_days ? parseFloat(avg_flowering_days) : null,
        description,
        lineage,
        cannabinoids,
        terpenes
      };

      const submitBtn = form.querySelector('button[type="submit"]');
      const originalBtnText = submitBtn.textContent;
      submitBtn.textContent = 'Saving...';
      submitBtn.disabled = true;

      try {
        const urlName = encodeURIComponent(strainName);
        const response = await fetch(`/api/strains/${urlName}/update`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          throw new Error('Failed to update strain details');
        }

        const updatedData = await response.json();
        state.currentStrainData = updatedData;
        const panel = document.getElementById('strain-panel');
        panel.innerHTML = renderStrainCard(updatedData);
        if (typeof renderLineageTree === 'function') {
          renderLineageTree(updatedData.name, updatedData.lineage);
        }

        // Trigger a reload of network data to update UI node representations
        const ndResp = await fetch('/api/network-data');
        if (ndResp.ok) {
          const ndData = await ndResp.json();
          state.allNodes = ndData.nodes || [];
          state.allRelationships = ndData.relationships || [];
          state.allTerpeneRels = ndData.terpeneRelationships || [];
          console.log('Nodes loaded after update:', state.allNodes.length);
          console.log('Genetic relationships loaded after update:', state.allRelationships.length);
          console.log('Terpene relationships loaded after update:', state.allTerpeneRels.length);
          renderStats();
          if (state.currentView === 'network') {
            buildGraph();
            if (state.nodes && state.nodes.get(updatedData.name) && state.network) {
              state.network.selectNodes([updatedData.name]);
              state.network.focus(updatedData.name, { scale: 1.5, animation: true });
            }
          }
        }
      } catch (err) {
        alert(err.message);
        submitBtn.textContent = originalBtnText;
        submitBtn.disabled = false;
      }
    });
  }

  // ── Search ──
  let searchAbortController = null;

  function performSearch(term) {
    const lower = term.toLowerCase().trim();
    const resultsEl = document.getElementById('search-results');

    // Always filter graph nodes visually
    if (state.nodes) {
      const allNodes = state.nodes.get();
      const updates = [];
      allNodes.forEach(n => {
        const currentOpacity = n.opacity !== undefined ? n.opacity : 1;
        const targetOpacity = !lower ? 1 : (n.label.toLowerCase().includes(lower) ? 1 : 0.15);
        if (currentOpacity !== targetOpacity) {
          updates.push({ id: n.id, opacity: targetOpacity });
        }
      });
      if (updates.length > 0) {
        state.nodes.update(updates);
      }
    }

    // If empty, hide dropdown
    if (!lower) {
      resultsEl.classList.remove('active');
      resultsEl.replaceChildren();
      return;
    }

    // Query the API for matching strains
    if (searchAbortController) searchAbortController.abort();
    searchAbortController = new AbortController();

    fetch('/api/strains?search=' + encodeURIComponent(lower), {
      signal: searchAbortController.signal,
    })
      .then(r => r.json())
      .then(data => {
        resultsEl.replaceChildren();
        const strains = data.strains || [];
        if (strains.length === 0) {
          const noResults = document.createElement('div');
          noResults.className = 'search-no-results';
          noResults.textContent = 'No strains found for "' + term.trim() + '"';
          resultsEl.appendChild(noResults);
        } else {
          strains.forEach(s => {
            const item = document.createElement('div');
            item.className = 'search-result-item';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'search-result-name';
            nameSpan.textContent = (s.name || '').replace(/_/g, ' ');
            item.appendChild(nameSpan);

            const metaDiv = document.createElement('span');
            metaDiv.className = 'search-result-meta';

            if (s.rsp) {
              const rspSpan = document.createElement('span');
              rspSpan.className = 'search-result-rsp';
              rspSpan.textContent = s.rsp;
              metaDiv.appendChild(rspSpan);
            }

            if (s.complete) {
              const badge = document.createElement('span');
              badge.className = 'search-result-badge complete';
              badge.textContent = 'Complete';
              metaDiv.appendChild(badge);
            }

            if (s.has_terpenes) {
              const badge = document.createElement('span');
              badge.className = 'search-result-badge terpenes';
              badge.textContent = 'Terpenes';
              metaDiv.appendChild(badge);
            }

            if (s.source === 'seedfinder') {
              const badge = document.createElement('span');
              badge.className = 'search-result-badge seedfinder';
              badge.textContent = 'SeedFinder';
              metaDiv.appendChild(badge);
            }

            if (s.source === 'forum') {
              const badge = document.createElement('span');
              badge.className = 'search-result-badge forum';
              badge.textContent = 'Forums';
              metaDiv.appendChild(badge);
            }

            if (!s.rsp && s.source !== 'seedfinder' && s.source !== 'forum') {
              const badge = document.createElement('span');
              badge.className = 'search-result-badge community';
              badge.textContent = 'Community';
              metaDiv.appendChild(badge);
            }

            item.appendChild(metaDiv);

            item.addEventListener('click', () => {
              resultsEl.classList.remove('active');
              resultsEl.replaceChildren();
              
              if (s.source === 'seedfinder' || s.source === 'forum') {
                document.getElementById('search-input').value = s.real_name;
                loadStrainDetail(s.real_name, s.source, s.strain_slug, s.breeder_slug, s.real_name);
              } else {
                document.getElementById('search-input').value = (s.name || '').replace(/_/g, ' ');
                loadStrainDetail(s.name);

                // Focus and activate graph node if it exists
                if (state.nodes) {
                  const nodeId = s.name;
                  const existing = state.nodes.get(nodeId);
                  if (existing && state.network) {
                    state.network.selectNodes([nodeId]);
                    state.network.focus(nodeId, { scale: 1.5, animation: true });
                    activateNode(nodeId);
                  }
                }
              }
            });

            resultsEl.appendChild(item);
          });
        }
        resultsEl.classList.add('active');
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          // Silently fail on search errors
        }
      });
  }

  // Close search dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const resultsEl = document.getElementById('search-results');
    const searchInput = document.getElementById('search-input');
    if (resultsEl && !resultsEl.contains(e.target) && e.target !== searchInput) {
      resultsEl.classList.remove('active');
    }
  });


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
        let pool = [];
        if (state.relType === 'genetic') {
          pool = state.allRelationships.map(r => ({ ...r, type: 'genetic' }));
        } else if (state.relType === 'terpene') {
          pool = state.allTerpeneRels.map(r => ({ ...r, type: 'terpene' }));
        } else if (state.relType === 'lineage') {
          pool = state.allLineageRels.map(r => ({ ...r, type: 'lineage' }));
        } else {
          const gen = state.allRelationships.map(r => ({ ...r, type: 'genetic' }));
          const terp = state.allTerpeneRels.map(r => ({ ...r, type: 'terpene' }));
          const lin = state.allLineageRels.map(r => ({ ...r, type: 'lineage' }));
          pool = [...gen, ...terp, ...lin];
        }
        renderFullPhylogeneticTree(container, state.nodes, pool, state.relType);
      }
    }
  }

  function switchRelType(type) {
    state.relType = type;
    document.querySelectorAll('.rel-btn').forEach(btn => {
      btn.classList.remove('active-genetic', 'active-terpene', 'active-lineage', 'active-combined');
      if (btn.dataset.rel === type) {
        btn.classList.add(`active-${type}`);
      }
    });

    // Clear and rebuild edges for the new relation type
    refreshAllEdges();
    
    // Re-enable physics to allow the graph to re-stabilize and cluster according to the new relationships!
    if (state.network) {
      state.network.setOptions({
        physics: {
          ...CALM_PHYSICS,
          enabled: true,
          stabilization: { enabled: true, iterations: 150, updateInterval: 25 }
        }
      });
      state.physicsOn = true;
      // After stabilization, turn off physics again
      state.network.once('stabilizationIterationsDone', () => {
        state.network.setOptions({ physics: { enabled: false } });
        state.physicsOn = false;
      });
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

      // Determine active pool of relationships
      let pool = [];
      if (state.relType === 'genetic') {
        pool = state.allRelationships.map(r => ({ ...r, type: 'genetic' }));
      } else if (state.relType === 'terpene') {
        pool = state.allTerpeneRels.map(r => ({ ...r, type: 'terpene' }));
      } else if (state.relType === 'lineage') {
        pool = state.allLineageRels.map(r => ({ ...r, type: 'lineage' }));
      } else { // combined
        const gen = state.allRelationships.map(r => ({ ...r, type: 'genetic' }));
        const terp = state.allTerpeneRels.map(r => ({ ...r, type: 'terpene' }));
        const lin = state.allLineageRels.map(r => ({ ...r, type: 'lineage' }));
        pool = [...gen, ...terp, ...lin];
      }

      const rels = pool
        .filter(r => (r.from === nodeId || r.to === nodeId) && r.distance < 0.5 && state.nodes.get(r.from === nodeId ? r.to : r.from))
        .sort((a, b) => a.distance - b.distance).slice(0, 4);

      rels.forEach(rel => {
        const childId = rel.from === nodeId ? rel.to : rel.from;
        if (!processed.has(childId)) {
          const ek = [nodeId, childId].sort().join('_');
          if (!processedEdges.has(ek)) {
            processedEdges.add(ek);
            
            const type = rel.type || (state.allTerpeneRels.some(r => r.from === rel.from && r.to === rel.to) ? 'terpene' : 'genetic');
            const edgeColor = COLORS[type].edge;
            const titlePrefix = type === 'genetic' ? 'Genetic' : 'Terpene';

            treeEdges.add({
              id: `e_${ek}_${level}`, from: `${nodeId}_${level}`, to: `${childId}_${level + 1}`,
              width: 2, color: { color: edgeColor, opacity: 0.6 },
              title: `${titlePrefix} Distance: ${rel.distance.toFixed(3)}`,
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



  // ── Physics Toggle ──
  function togglePhysics() {
    state.physicsOn = !state.physicsOn;
    state.network.setOptions({
      physics: {
        ...CALM_PHYSICS,
        enabled: state.physicsOn,
        stabilization: { enabled: true, iterations: 100 }
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

  // ── Lineage Tree & Formatting Helpers ──
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function buildLineageData(name, detailLineage, depth = 0) {
    if (depth >= 3 || !name) return null;
    
    const nodeName = name.replace(/_/g, ' ');
    const treeNode = {
      name: nodeName,
      originalName: name,
      parents: []
    };
    
    if (depth === 0 && detailLineage) {
      let parentNames = [];
      if (Array.isArray(detailLineage)) {
        parentNames = detailLineage.map(p => typeof p === 'object' ? p.name : p);
      } else if (typeof detailLineage === 'object' && Object.keys(detailLineage).length > 0) {
        parentNames = Object.keys(detailLineage);
      } else if (typeof detailLineage === 'string' && detailLineage.toLowerCase() !== 'unknown') {
        const crossRegex = /\s+[xX×]\s+|\s+x\s+|_x_|_X_/g;
        if (crossRegex.test(detailLineage)) {
          parentNames = detailLineage.split(crossRegex);
        }
      }
      
      if (parentNames.length > 0) {
        treeNode.parents = parentNames
          .filter(Boolean)
          .map(pName => buildLineageData(pName.trim(), null, depth + 1))
          .filter(Boolean);
        return treeNode;
      }
    }
    
    const crossRegex = /\s+[xX×]\s+|\s+x\s+|_x_|_X_/g;
    if (crossRegex.test(name)) {
      const parts = name.split(crossRegex).map(p => p.trim());
      treeNode.parents = parts
        .filter(Boolean)
        .map(pName => buildLineageData(pName, null, depth + 1))
        .filter(Boolean);
    }
    
    return treeNode;
  }

  function getColumnsFromTree(treeNode) {
    const columns = [[], [], []];
    
    function traverse(node, depth) {
      if (!node || depth >= 3) return;
      
      columns[depth].push(node);
      
      if (node.parents && node.parents.length > 0) {
        node.parents.forEach(parent => {
          parent.childName = node.name;
          traverse(parent, depth + 1);
        });
      }
    }
    
    traverse(treeNode, 0);
    return columns;
  }

  function drawLineageConnections(container) {
    const svg = container.querySelector('.tree-svg-overlay');
    if (!svg) return;
    svg.replaceChildren();
    
    const containerRect = container.getBoundingClientRect();
    const nodes = container.querySelectorAll('.tree-node');
    
    nodes.forEach(node => {
      const childName = node.dataset.parentId;
      if (!childName) return;
      
      const childNode = container.querySelector(`[data-node-id="${childName}"]`);
      if (!childNode) return;
      
      const parentRect = node.getBoundingClientRect();
      const childRect = childNode.getBoundingClientRect();
      
      const startX = parentRect.right - containerRect.left;
      const startY = parentRect.top + parentRect.height / 2 - containerRect.top;
      
      const endX = childRect.left - containerRect.left;
      const endY = childRect.top + childRect.height / 2 - containerRect.top;
      
      if (isNaN(startX) || isNaN(startY) || isNaN(endX) || isNaN(endY)) return;
      
      const controlX = startX + (endX - startX) / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`);
      path.setAttribute('stroke', 'rgba(0, 210, 255, 0.4)');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('fill', 'none');
      
      svg.appendChild(path);
    });
  }

  function renderLineageTree(name, detailLineage) {
    const container = document.getElementById('family-tree-card');
    if (!container) return;
    container.replaceChildren();
    
    const treeData = buildLineageData(name, detailLineage);
    if (!treeData || !treeData.parents || treeData.parents.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-tree-state';
      empty.textContent = 'No lineage parents found for this cultivar.';
      container.appendChild(empty);
      return;
    }
    
    const columns = getColumnsFromTree(treeData);
    
    const treeWrapper = document.createElement('div');
    treeWrapper.className = 'family-tree-container';
    treeWrapper.style.position = 'relative';
    
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'tree-svg-overlay');
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    treeWrapper.appendChild(svg);
    
    const viewport = document.createElement('div');
    viewport.className = 'tree-viewport';
    
    for (let i = 2; i >= 0; i--) {
      const colNodes = columns[i];
      if (!colNodes || colNodes.length === 0) continue;
      
      const colDiv = document.createElement('div');
      colDiv.className = 'tree-column';
      
      colNodes.forEach(node => {
        const nodeEl = document.createElement('div');
        nodeEl.className = 'tree-node';
        if (i === 0) {
          nodeEl.classList.add('active-node');
        }
        nodeEl.textContent = node.name;
        nodeEl.dataset.nodeId = node.name;
        if (node.childName) {
          nodeEl.dataset.parentId = node.childName;
        }
        
        nodeEl.addEventListener('click', () => {
          const normalizedNodeName = node.originalName;
          const found = state.allNodes.find(n => 
            n.id.toLowerCase() === normalizedNodeName.toLowerCase() ||
            n.label.toLowerCase() === normalizedNodeName.replace(/_/g, ' ').toLowerCase()
          );
          if (found) {
            handleNodeClick(found.id);
            if (state.nodes && state.nodes.get(found.id) && state.network) {
              state.network.selectNodes([found.id]);
              state.network.focus(found.id, { scale: 1.4, animation: true });
            }
          } else {
            loadStrainDetail(node.originalName);
          }
        });
        
        colDiv.appendChild(nodeEl);
      });
      
      viewport.appendChild(colDiv);
    }
    
    treeWrapper.appendChild(viewport);
    container.appendChild(treeWrapper);
    
    setTimeout(() => {
      drawLineageConnections(treeWrapper);
    }, 150);
    
    const resizeObserver = new ResizeObserver(() => {
      drawLineageConnections(treeWrapper);
    });
    resizeObserver.observe(treeWrapper);
  }

})();
