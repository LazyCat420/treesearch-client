function renderFullPhylogeneticTree(container, nodes, allRelationships) {
    console.log('Rendering full phylogenetic tree');
    container.innerHTML = '';
    
    const treeNodes = new vis.DataSet();
    const treeEdges = new vis.DataSet();
    const processedNodes = new Set();
    const processedEdges = new Set();
    
    // Get all nodes that are either complete (blue) or incomplete (grey)
    const allStrains = nodes.get().filter(node => 
        node.color?.background === '#2B7CE9' || node.color?.background === '#97C2FC'
    );
    
    // Sort strains by RSP number for consistent root selection
    allStrains.sort((a, b) => (a.rsp || '').localeCompare(b.rsp || ''));
    
    function addNodeToTree(nodeId, level) {
        if (processedNodes.has(nodeId)) return;
        
        const node = nodes.get(nodeId);
        if (!node) return;
        
        processedNodes.add(nodeId);
        
        // Add node to tree
        const nodeLabel = (node.label || node.id).replace(/_/g, ' ');
        treeNodes.add({
            id: nodeId,
            label: nodeLabel,
            level: level,
            color: {
                background: node.color?.background || '#3a7bd5',
                border: node.color?.border || '#5c9ce6'
            },
            size: Math.max(15, 25 - (level * 2)),
            font: {
                size: Math.max(12, 16 - (level * 0.5)),
                face: 'Inter, arial',
                color: '#e8e8f0',
                strokeWidth: 2,
                strokeColor: '#0a0a14'
            },
            title: `${nodeLabel}\nRSP: ${node.rsp || 'Unknown'}`
        });
        
        // Find relationships
        const relationships = allRelationships
            .filter(rel => {
                const isConnected = (rel.from === nodeId || rel.to === nodeId);
                const withinDistance = rel.distance < 0.2;
                const otherNode = rel.from === nodeId ? rel.to : rel.from;
                const hasValidNode = nodes.get(otherNode);
                return isConnected && withinDistance && hasValidNode;
            })
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 3);
        
        relationships.forEach(rel => {
            const childId = rel.from === nodeId ? rel.to : rel.from;
            if (!processedNodes.has(childId)) {
                const edgeKey = [nodeId, childId].sort().join('_');
                if (!processedEdges.has(edgeKey)) {
                    processedEdges.add(edgeKey);
                    
                    treeEdges.add({
                        id: `edge_${edgeKey}`,
                        from: nodeId,
                        to: childId,
                        width: Math.max(1, 2 - (level * 0.3)),
                        color: { 
                            color: '#00d2ff', 
                            opacity: Math.max(0.3, 0.8 - (level * 0.1)) 
                        },
                        title: `Genetic Distance: ${rel.distance.toFixed(3)}`
                    });
                    
                    addNodeToTree(childId, level + 1);
                }
            }
        });
    }
    
    // Start with the first strain as root
    if (allStrains.length > 0) {
        addNodeToTree(allStrains[0].id, 0);
    }
    
    // Create the network
    const treeNetwork = new vis.Network(container, {
        nodes: treeNodes,
        edges: treeEdges
    }, {
        physics: {
            enabled: true,
            hierarchicalRepulsion: {
                nodeDistance: 150,
                springLength: 150
            },
            stabilization: {
                iterations: 200,
                updateInterval: 50
            }
        },
        layout: {
            hierarchical: {
                enabled: true,
                direction: 'UD',
                sortMethod: 'directed',
                levelSeparation: 100,
                nodeSpacing: 100,
                treeSpacing: 100,
                blockShifting: true,
                edgeMinimization: true,
                parentCentralization: true
            }
        },
        interaction: {
            dragNodes: false,
            dragView: true,
            zoomView: true,
            hover: true,
            tooltipDelay: 200
        }
    });
    
    // Add scale bar
    const scaleBar = document.createElement('div');
    scaleBar.style.cssText = `
        position: absolute;
        bottom: 80px;
        left: 20px;
        background: rgba(22, 22, 38, 0.9);
        padding: 10px;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        font-size: 12px;
        color: #8888a0;
    `;
    scaleBar.innerHTML = `
        <div>Genetic Distance Scale:</div>
        <div style="display: flex; align-items: center; margin-top: 5px;">
            <div style="border-top: 2px solid #00d2ff; width: 50px;"></div>
            <div style="margin-left: 5px; color: #e8e8f0;">0.05</div>
        </div>
        <div style="display: flex; align-items: center; margin-top: 5px;">
            <div style="border-top: 2px solid #00d2ff; width: 100px;"></div>
            <div style="margin-left: 5px; color: #e8e8f0;">0.10</div>
        </div>
    `;
    container.appendChild(scaleBar);
    
    // Add fit button
    const controls = document.createElement('div');
    controls.style.cssText = `
        position: absolute;
        bottom: 20px;
        right: 20px;
        display: flex;
        gap: 10px;
    `;
    
    const fitButton = document.createElement('button');
    fitButton.textContent = '⟲';
    fitButton.title = 'Fit to View';
    fitButton.onclick = () => treeNetwork.fit({ animation: true });
    fitButton.style.cssText = `
        width: 38px;
        height: 38px;
        border-radius: 50%;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(22, 22, 38, 0.85);
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        cursor: pointer;
        font-size: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #8888a0;
    `;
    
    controls.appendChild(fitButton);
    container.appendChild(controls);
    
    // Initial fit to view
    setTimeout(() => treeNetwork.fit(), 100);
    
    return treeNetwork;
} 