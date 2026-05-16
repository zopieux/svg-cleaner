async function main() {
    const statusText = document.getElementById('statusText');
    const statusSpinner = document.getElementById('statusSpinner');
    const fileInput = document.getElementById('fileInput');
    const snapToleranceInput = document.getElementById('snapTolerance');
    const origPreview = document.getElementById('origPreview');
    const cleanPreview = document.getElementById('cleanPreview');
    const downloadBtn = document.getElementById('downloadBtn');
    const status = document.getElementById('status');

    let pyodide;
    let cleanedSvgContent = null;

    async function loadPyodideAndPackages() {
        try {
            pyodide = await loadPyodide({
                indexURL: "pyodide/"
            });
            
            statusText.innerText = "Loading Python packages...";
            
            // For standalone, we should have the wheels in the same dir
            // But Pyodide's loadPackage can take URLs
            await pyodide.loadPackage(["numpy", "scipy", "networkx", "shapely"]);
            
            // We need micropip for svgpathtools if not bundled as a wheel
            await pyodide.loadPackage("micropip");
            const micropip = pyodide.pyimport("micropip");
            
            // In a truly standalone nix build, we provide the wheels in the pyodide dir.
            await micropip.install("pyodide/svgwrite-1.4.3-py3-none-any.whl");
            await micropip.install("pyodide/svgpathtools-1.7.2-py2.py3-none-any.whl");

            statusText.innerText = "Loading logic...";
            
            // Fetch and load clean_svg.py
            const response = await fetch('clean_svg.py');
            const cleanSvgCode = await response.text();
            pyodide.FS.writeFile('clean_svg.py', cleanSvgCode);
            
            // Create the wrapper
            pyodide.runPython(`
import clean_svg
import io
import sys
from svgpathtools import wsvg

def process_svg_string(svg_str, tolerance):
    bio_in = io.BytesIO(svg_str.encode('utf-8'))
    paths, attributes = clean_svg.load_svg_cleaned(bio_in)
    
    class Args:
        def __init__(self, snap_tolerance):
            self.snap_tolerance = snap_tolerance
    
    args = Args(tolerance)
    out_paths = clean_svg.process_svg(paths, args)
    
    # Write to a virtual file and read it back
    wsvg(out_paths, filename='out.svg')
    with open('out.svg', 'r') as f:
        return f.read()
            `);

            status.classList.add('hidden');
            fileInput.disabled = false;
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
            const content = e.target.result;
            origPreview.innerHTML = content;
            
            status.classList.remove('hidden');
            statusText.innerText = "Processing SVG...";
            
            try {
                const tolerance = parseFloat(snapToleranceInput.value) || 0.1;
                const processSvg = pyodide.globals.get('process_svg_string');
                cleanedSvgContent = processSvg(content, tolerance);
                
                cleanPreview.innerHTML = cleanedSvgContent;
                downloadBtn.classList.remove('hidden');
                
                status.classList.add('hidden');
            } catch (err) {
                console.error(err);
                alert("Error processing SVG: " + err.message);
                status.classList.add('hidden');
            }
        };
        reader.readAsText(file);
    }

    fileInput.addEventListener('change', (e) => {
        handleFile(e.target.files[0]);
    });

    snapToleranceInput.addEventListener('change', () => {
        if (fileInput.files[0]) {
            handleFile(fileInput.files[0]);
        }
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

    loadPyodideAndPackages();
}

main();
