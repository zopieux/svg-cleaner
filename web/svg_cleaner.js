class SVGCleaner {
    constructor(pyodidePath = "pyodide/") {
        this.pyodidePath = pyodidePath;
        this.pyodide = null;
        this.isLoaded = false;
    }

    async load(onProgress = null) {
        if (this.isLoaded) return;
        const log = (msg) => {
            console.log(msg);
            if (onProgress) onProgress(msg);
        };

        log("Loading Pyodide...");
        this.pyodide = await loadPyodide({
            indexURL: this.pyodidePath
        });

        log("Loading micropip...");
        await this.pyodide.loadPackage("micropip");
        const micropip = this.pyodide.pyimport("micropip");

        log("Mocking dependencies...");
        // Mock unused heavy dependencies BEFORE loading other packages
        // This prevents micropip from downloading them as transitive dependencies.
        this.pyodide.globals.set("mock_data", [
            ["matplotlib", "9.9.9", { "matplotlib": null, "matplotlib.pyplot": null, "matplotlib.colors": null }],
            ["Pillow", "9.9.9", { "PIL": null, "PIL.Image": null }],
            ["pytz", "9.9.9", { "pytz": null }],
            ["python-dateutil", "9.9.9", { "dateutil": null, "dateutil.parser": null }],
            ["pyparsing", "9.9.9", { "pyparsing": null }],
            ["fonttools", "9.9.9", { "fontTools": null }],
            ["kiwisolver", "9.9.9", { "kiwisolver": null }],
            ["cycler", "9.9.9", { "cycler": null }],
            ["six", "9.9.9", { "six": null }],
            ["decorator", "9.9.9", { "decorator": null }]
        ]);
        this.pyodide.runPython(`
import micropip
from pyodide.ffi import JsProxy
for name, version, modules in mock_data:
    if isinstance(modules, JsProxy):
        modules = modules.to_py()
    micropip.add_mock_package(name, version, modules=modules)
        `);

        log("Loading NumPy & SciPy...");
        await micropip.install(["numpy", "scipy"]);
        
        log("Loading Shapely & NetworkX...");
        await micropip.install(["networkx", "shapely"]);

        log("Installing SVG wheels...");
        await micropip.install(`${this.pyodidePath}svgwrite-1.4.3-py3-none-any.whl`);
        await micropip.install(`${this.pyodidePath}svgpathtools-1.7.2-py2.py3-none-any.whl`);

        log("Loading clean_svg.py...");
        const response = await fetch('clean_svg.py');
        const cleanSvgCode = await response.text();
        this.pyodide.FS.writeFile('clean_svg.py', cleanSvgCode);

        log("Finalizing environment...");
        this.pyodide.runPython(`from clean_svg import process_svg_string`);
        log("SVGCleaner fully loaded.");
        this.isLoaded = true;
    }

    process(svgString, tolerance = 0.1) {
        if (!this.isLoaded) throw new Error("SVGCleaner not loaded");
        const processSvg = this.pyodide.globals.get('process_svg_string');
        return processSvg(svgString, tolerance);
    }
}

// Export if in a module environment, otherwise attach to window
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SVGCleaner;
} else {
    window.SVGCleaner = SVGCleaner;
}
