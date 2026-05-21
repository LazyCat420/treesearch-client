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
  async function loadStrainDetail(strainName, source, strainSlug, breederSlug, realName) {
    const panel = document.getElementById('strain-panel');
    panel.innerHTML = `<div class="empty-state"><div class="loading-spinner"></div><div>Loading...</div></div>`;

    try {
      let resp;
      if (source === 'seedfinder' || source === 'forum') {
        panel.innerHTML = `<div class="empty-state"><div class="loading-spinner"></div><div>Scraping & Aggregating details for ${realName}...</div></div>`;
        resp = await fetch('/api/strains/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strain_slug: strainSlug, breeder_slug: breederSlug })
        });
      } else {
        resp = await fetch(`/api/strains/${encodeURIComponent(strainName)}/detail`);
      }
      if (!resp.ok) throw new Error('Not found');
      const d = await resp.json();
      panel.innerHTML = renderStrainCard(d);
      if (typeof renderLineageTree === 'function') {
        renderLineageTree(d.name, d.lineage);
      }

      if (source === 'seedfinder' || source === 'forum') {
        // Trigger a reload of network data so the newly imported strain node appears in the visualization
        try {
          const ndResp = await fetch('/api/network-data');
          if (ndResp.ok) {
            const ndData = await ndResp.json();
            state.allNodes = ndData.nodes || [];
            state.allRelationships = ndData.relationships || [];
            state.allTerpeneRels = ndData.terpeneRelationships || [];
            renderStats();
            if (state.currentView === 'network') {
              buildGraph();
              // Try to select the node
              const targetNodeId = d.name;
              if (state.nodes && state.network) {
                state.network.selectNodes([targetNodeId]);
                state.network.focus(targetNodeId, { scale: 1.5, animation: true });
              }
            }
          }
        } catch (ndErr) {
          console.error('Failed to update network graph:', ndErr);
        }
      }
    } catch (err) {
      // Fallback for strains with no sample data
      const node = state.nodes ? state.nodes.get(strainName) : null;
      panel.innerHTML = renderBasicCard(strainName, node);
      if (typeof renderLineageTree === 'function') {
        renderLineageTree(strainName, null);
      }
    }
  }



  function renderStrainCard(d) {
    let html = `<div class="strain-card">
      <h2>${(d.name || '').replace(/_/g, ' ')}</h2>
      ${d.rsp ? `<span class="rsp-badge">${d.rsp}</span>` : ''}`;

    // Strain-level info (breeder, type, description) — always available
    const hasStrainInfo = d.description || d.strain_type || d.breeder || (d.lineage && Object.keys(d.lineage).length);
    if (hasStrainInfo) {
      html += `<div class="card-section"><h3>Strain Information</h3><div class="meta-grid">`;
      if (d.breeder) html += `<div class="meta-item"><div class="label">Breeder</div><div class="value">${d.breeder}</div></div>`;
      if (d.strain_type) html += `<div class="meta-item"><div class="label">Type</div><div class="value">${d.strain_type}</div></div>`;
      if (d.avg_flowering_days) html += `<div class="meta-item"><div class="label">Flowering</div><div class="value">${d.avg_flowering_days} days</div></div>`;
      html += `</div>`;
      if (d.description) html += `<p style="color:var(--text-secondary);font-size:13px;line-height:1.5;margin-top:8px">${d.description}</p>`;
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
    }

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
          html += `<div class="gallery-image-card">
            <img src="${img.image_url}" alt="Strain image" onerror="this.src='https://images.unsplash.com/photo-1603909223429-69bb7101f420?w=300'" class="gallery-img" />
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
      html += `<div class="card-section"><h3>Grow Reports & Observations</h3>`;
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
        
        html += `<div class="observation-quote-card">
          <div class="observation-header">
            <span class="observation-title">${escapeHtml(title || 'Observation Note')}</span>
            <span class="observation-date">${displayDate}</span>
          </div>
          <blockquote class="observation-quote" id="obs-text-${idx}" data-full="${escapedFull}" data-short="${escapedShort}">"${isLong ? escapedShort : escapedFull}"</blockquote>
          ${isLong ? `<button class="expand-btn" data-idx="${idx}">Show More</button>` : ''}
          <div class="quote-footer">
            <span class="author">— ${escapeHtml(obs.author || 'Anonymous')}</span>
            <span class="source">via <a href="${obs.source_url || '#'}" target="_blank">${escapeHtml(obs.source_name || 'Source')}</a></span>
          </div>
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

    // Click delegation for neighbor items and expand buttons
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

                // Focus graph node if it exists
                if (state.nodes) {
                  const nodeId = s.name;
                  const existing = state.nodes.get(nodeId);
                  if (existing && state.network) {
                    state.network.selectNodes([nodeId]);
                    state.network.focus(nodeId, { scale: 1.5, animation: true });
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
    svg.className = 'tree-svg-overlay';
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
            if (state.network) {
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
