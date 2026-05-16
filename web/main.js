async function main() {
    const statusText = document.getElementById('statusText');
    const statusSpinner = document.getElementById('statusSpinner');
    const fileInput = document.getElementById('fileInput');
    const snapToleranceInput = document.getElementById('snapTolerance');
    const origPreview = document.getElementById('origPreview');
    const cleanPreview = document.getElementById('cleanPreview');
    const downloadBtn = document.getElementById('downloadBtn');
    const status = document.getElementById('status');

    window.cleaner = new SVGCleaner("pyodide/");
    const cleaner = window.cleaner;
    let cleanedSvgContent = null;
    let originalSvgContent = null;

    // Settings state
    let apparentThickness = parseFloat(localStorage.getItem('apparentThickness')) || 1.0;
    let snapTolerance = parseFloat(localStorage.getItem('snapTolerance')) || 0.1;
    let highlightPaths = localStorage.getItem('highlightPaths') !== 'false';
    let strokeStyle = localStorage.getItem('strokeStyle') || 'sharp';

    // Update UI with saved settings
    snapToleranceInput.value = snapTolerance;
    const highlightPathsCheckbox = document.getElementById('highlightPaths');
    highlightPathsCheckbox.checked = highlightPaths;

    const strokeStyleGroup = document.getElementById('strokeStyleGroup');
    const styleButtons = strokeStyleGroup.querySelectorAll('button');
    styleButtons.forEach(btn => {
        if (btn.dataset.value === strokeStyle) btn.classList.add('active');
        btn.addEventListener('click', () => {
            styleButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            strokeStyle = btn.dataset.value;
            saveSettings();
            applyAllVisuals();
        });
    });

    function saveSettings() {
        localStorage.setItem('apparentThickness', apparentThickness);
        localStorage.setItem('snapTolerance', snapToleranceInput.value);
        localStorage.setItem('highlightPaths', highlightPathsCheckbox.checked);
        localStorage.setItem('strokeStyle', strokeStyle);
    }

    // Pan & Zoom state
    const views = new Map(); // element -> { scale, x, y }

    function initView(el) {
        const state = { scale: 1, x: 0, y: 0 };
        views.set(el, state);
        el.style.cursor = 'grab';

        const update = () => {
            const svg = el.querySelector('svg');
            if (svg) {
                svg.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
                svg.style.transformOrigin = '0 0';
                updateNodesForContainer(el);
            }
        };

        const fit = () => {
            const svg = el.querySelector('svg');
            if (!svg) return;

            svg.style.transform = '';
            svg.style.width = '';
            svg.style.height = '';

            const rect = el.getBoundingClientRect();
            let svgW, svgH;

            if (svg.viewBox && svg.viewBox.baseVal) {
                svgW = svg.viewBox.baseVal.width;
                svgH = svg.viewBox.baseVal.height;
            } else {
                const svgRect = svg.getBoundingClientRect();
                svgW = svgRect.width;
                svgH = svgRect.height;
            }

            if (!svgW || !svgH) return;

            const padding = 20;
            const availableW = rect.width - padding * 2;
            const availableH = rect.height - padding * 2;

            const scale = Math.min(availableW / svgW, availableH / svgH);
            state.scale = scale;
            state.x = (rect.width - svgW * scale) / 2;
            state.y = (rect.height - svgH * scale) / 2;

            update();
        };

        state.fit = fit;

        el.addEventListener('wheel', (e) => {
            e.preventDefault();

            if (e.shiftKey) {
                // Adjust thickness
                const delta = -e.deltaY;
                const factor = Math.pow(1.1, delta / 100);
                apparentThickness *= factor;
                apparentThickness = Math.max(0.1, Math.min(20, apparentThickness));
                saveSettings();
                applyAllVisuals();
                return;
            }

            const delta = -e.deltaY;
            const factor = Math.pow(1.1, delta / 100);

            const rect = el.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const svgX = (mouseX - state.x) / state.scale;
            const svgY = (mouseY - state.y) / state.scale;

            const newScale = state.scale * factor;

            state.x = mouseX - svgX * newScale;
            state.y = mouseY - svgY * newScale;
            state.scale = newScale;

            update();
        }, { passive: false });

        let isPanning = false;
        let startX, startY;

        el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            isPanning = true;
            el.style.cursor = 'grabbing';
            startX = e.clientX;
            startY = e.clientY;
        });

        window.addEventListener('mousemove', (e) => {
            if (!isPanning) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            state.x += dx;
            state.y += dy;
            startX = e.clientX;
            startY = e.clientY;
            update();
        });

        window.addEventListener('mouseup', () => {
            if (isPanning) {
                isPanning = false;
                el.style.cursor = 'grab';
            }
        });
    }

    initView(origPreview);
    initView(cleanPreview);

    // Shift key for nodes
    let shiftPressed = false;
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Shift') {
            shiftPressed = true;
            document.body.classList.add('show-nodes');
            updateAllNodes();
        }
    });

    window.addEventListener('keyup', (e) => {
        if (e.key === 'Shift') {
            shiftPressed = false;
            document.body.classList.remove('show-nodes');
            updateAllNodes();
        }
    });
    
    function updateTransform(container) {
        const state = views.get(container);
        const svg = container.querySelector('svg.preview-svg');
        if (svg && state) {
            svg.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
            svg.style.transformOrigin = '0 0';
            updateNodesForContainer(container);
        }
    }

    function renderPreviews() {
        if (originalSvgContent) {
            origPreview.innerHTML = originalSvgContent;
            const svg = origPreview.querySelector('svg');
            if (svg) svg.classList.add('preview-svg');
            updateTransform(origPreview);
            requestAnimationFrame(() => applyVisuals(origPreview));
        }
        if (cleanedSvgContent) {
            cleanPreview.innerHTML = cleanedSvgContent;
            const svg = cleanPreview.querySelector('svg');
            if (svg) svg.classList.add('preview-svg');
            updateTransform(cleanPreview);
            requestAnimationFrame(() => applyVisuals(cleanPreview));
        }
    }

    function getNodesFromPath(d) {
        if (!d) return [];
        const tokens = d.split(/(?=[MLHVCSQTAZmlhvcsqtaz])/);
        let curX = 0, curY = 0;
        const coords = [];
        
        tokens.forEach(token => {
            const cmd = token[0];
            const args = token.slice(1).trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
            
            if (cmd === 'M' || cmd === 'L') {
                for (let i = 0; i < args.length; i += 2) {
                    curX = args[i]; curY = args[i+1];
                    coords.push({x: curX, y: curY});
                }
            } else if (cmd === 'm' || cmd === 'l') {
                for (let i = 0; i < args.length; i += 2) {
                    curX += args[i]; curY += args[i+1];
                    coords.push({x: curX, y: curY});
                }
            } else if (cmd === 'H') {
                args.forEach(x => { curX = x; coords.push({x: curX, y: curY}); });
            } else if (cmd === 'h') {
                args.forEach(dx => { curX += dx; coords.push({x: curX, y: curY}); });
            } else if (cmd === 'V') {
                args.forEach(y => { curY = y; coords.push({x: curX, y: curY}); });
            } else if (cmd === 'v') {
                args.forEach(dy => { curY += dy; coords.push({x: curX, y: curY}); });
            } else if (cmd === 'A') {
                for (let i = 0; i < args.length; i += 7) {
                    curX = args[i+5]; curY = args[i+6];
                    coords.push({x: curX, y: curY});
                }
            } else if (cmd === 'a') {
                for (let i = 0; i < args.length; i += 7) {
                    curX += args[i+5]; curY += args[i+6];
                    coords.push({x: curX, y: curY});
                }
            }
        });
        return coords;
    }

    function updateNodesForContainer(container) {
        const mainSvg = container.querySelector('svg.preview-svg');
        if (!mainSvg) return;

        let nodesOverlay = container.querySelector('.nodes-overlay');
        if (!nodesOverlay) {
            nodesOverlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            nodesOverlay.setAttribute('class', 'nodes-overlay');
            container.appendChild(nodesOverlay);
        }

        if (!shiftPressed) {
            nodesOverlay.classList.remove('active');
            nodesOverlay.innerHTML = '';
            nodesOverlay.dataset.svgId = "";
            return;
        }

        nodesOverlay.classList.add('active');

        // Re-parse paths only if SVG content changed
        const currentSvgId = mainSvg.innerHTML.length + (mainSvg.id || "0");
        if (nodesOverlay.dataset.svgId !== currentSvgId) {
            nodesOverlay.innerHTML = '';
            nodesOverlay.dataset.svgId = currentSvgId;
            const paths = Array.from(mainSvg.querySelectorAll('path')).filter(p => !p.closest('defs'));
            const nodesData = [];
            paths.forEach(path => {
                const d = path.getAttribute('d');
                const localNodes = getNodesFromPath(d);
                nodesData.push({ path, localNodes });
            });
            nodesOverlay.nodesData = nodesData;
            
            // Create diamond elements once
            nodesData.forEach(item => {
                item.localNodes.forEach(p => {
                    const diamond = document.createElementNS("http://www.w3.org/2000/svg", "path");
                    diamond.setAttribute('class', 'node-diamond');
                    const s = 4;
                    diamond.setAttribute('d', `M 0 -${s} L ${s} 0 L 0 ${s} L -${s} 0 Z`);
                    diamond.setAttribute('fill', 'white');
                    diamond.setAttribute('stroke', 'black');
                    diamond.setAttribute('stroke-width', '1');
                    nodesOverlay.appendChild(diamond);
                    p.element = diamond;
                });
            });
        }

        // Always update positions relative to current view
        const nodesData = nodesOverlay.nodesData;
        if (!nodesData) return;

        const overlayRect = nodesOverlay.getBoundingClientRect();
        const nodeSet = new Set();
        
        nodesData.forEach(item => {
            const matrix = item.path.getScreenCTM();
            if (!matrix) return;
            
            item.localNodes.forEach(p => {
                const screenX = p.x * matrix.a + p.y * matrix.c + matrix.e;
                const screenY = p.x * matrix.b + p.y * matrix.d + matrix.f;
                
                const localX = screenX - overlayRect.left;
                const localY = screenY - overlayRect.top;

                // Simple deduplication for visual clarity
                const key = `${Math.round(localX)},${Math.round(localY)}`;
                if (nodeSet.has(key)) {
                    p.element.setAttribute('display', 'none');
                } else {
                    nodeSet.add(key);
                    p.element.setAttribute('display', 'inline');
                    p.element.setAttribute('transform', `translate(${localX},${localY})`);
                }
            });
        });
    }

    function updateAllNodes() {
        updateNodesForContainer(origPreview);
        updateNodesForContainer(cleanPreview);
    }

    const PALETTE = [
        //  #48474a, #6ce5f7, #f7f6f7, #f2e85e, #8835cc, #f2960b, #327d46 and #cf1b1b. 
        '#6ce5f7', '#f7f6f7', '#f2e85e', '#8835cc', '#f2960b', '#327d46', '#cf1b1b'
    ];

    function applyVisuals(container) {
        const paths = Array.from(container.querySelectorAll('path:not(.node-diamond)'));
        if (paths.length === 0) return;

        const isHighlighting = highlightPathsCheckbox.checked;

        let pathData = [];
        if (isHighlighting) {
            pathData = paths.map(path => {
                let bbox;
                try { bbox = path.getBBox(); } catch (e) { bbox = { x: 0, y: 0, width: 0, height: 0 }; }
                return {
                    path,
                    cx: bbox.x + bbox.width / 2,
                    cy: bbox.y + bbox.height / 2,
                    area: bbox.width * bbox.height,
                    colorIdx: -1
                };
            });
            pathData.sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
        }

        paths.forEach((path, idx) => {
            path.style.fill = 'none';
            path.style.vectorEffect = 'non-scaling-stroke';
            path.style.strokeWidth = apparentThickness + 'px';

            if (strokeStyle === 'round') {
                path.style.strokeLinecap = 'round';
                path.style.strokeLinejoin = 'round';
            } else {
                path.style.strokeLinecap = 'butt';
                path.style.strokeLinejoin = 'miter';
            }

            if (!isHighlighting) {
                path.style.stroke = 'var(--text)';
            }
        });

        if (isHighlighting) {
            pathData.forEach((data, i) => {
                const usedColors = new Set();
                const lookback = Math.max(0, i - 20);
                for (let j = i - 1; j >= lookback; j--) {
                    const other = pathData[j];
                    const dx = data.cx - other.cx;
                    const dy = data.cy - other.cy;
                    const distSq = dx * dx + dy * dy;
                    const threshold = Math.sqrt(data.area + other.area) * 2;
                    if (distSq < threshold * threshold) {
                        usedColors.add(other.colorIdx);
                    }
                }
                let picked = 0;
                while (picked < PALETTE.length - 1 && usedColors.has(picked)) picked++;
                data.colorIdx = picked;
                data.path.style.stroke = PALETTE[picked];
            });
        }
    }

    function applyAllVisuals() {
        applyVisuals(origPreview);
        applyVisuals(cleanPreview);
    }

    async function process() {
        if (!cleaner.isLoaded || !originalSvgContent) return;

        status.classList.remove('hidden');
        statusText.innerText = "Processing SVG...";

        try {
            const tolerance = parseFloat(snapToleranceInput.value) || 0.1;
            cleanedSvgContent = cleaner.process(originalSvgContent, tolerance);

            renderPreviews();
            downloadBtn.classList.remove('hidden');

            status.classList.add('hidden');
            saveSettings();
        } catch (err) {
            console.error(err);
            statusText.innerText = "Error: " + err.message;
            statusSpinner.classList.add('hidden');
        }
    }

    async function init() {
        try {
            await cleaner.load((msg) => {
                statusText.innerText = msg;
            });
            status.classList.add('hidden');
            fileInput.disabled = false;

            if (originalSvgContent) {
                process();
            }
        } catch (err) {
            console.error(err);
            statusText.innerText = "Error: " + err.message;
            statusSpinner.classList.add('hidden');
        }
    }

    async function handleFile(file) {
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (e) => {
            originalSvgContent = e.target.result;
            cleanedSvgContent = null;
            renderPreviews();

            // Initial fit for new file
            requestAnimationFrame(() => {
                const fitOrig = views.get(origPreview).fit;
                const fitClean = views.get(cleanPreview).fit;
                if (fitOrig) fitOrig();
                if (fitClean) fitClean();
            });

            if (cleaner.isLoaded) {
                process();
            } else {
                status.classList.remove('hidden');
            }
        };
        reader.readAsText(file);
    }

    fileInput.addEventListener('change', (e) => {
        handleFile(e.target.files[0]);
    });

    snapToleranceInput.addEventListener('input', () => {
        if (originalSvgContent) {
            process();
        }
    });

    highlightPathsCheckbox.addEventListener('change', () => {
        saveSettings();
        renderPreviews();
    });

    downloadBtn.addEventListener('click', () => {
        if (!cleanedSvgContent) return;
        const blob = new Blob([cleanedSvgContent], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'cleaned.svg';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    init();
}

main();
