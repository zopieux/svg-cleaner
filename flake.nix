{
  description = "SVG CAD Cleaner with Pyodide Web UI";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      pkgs = import nixpkgs {
        system = "x86_64-linux";
      };

      pyodideVersion = "0.28.2";
      pyodideTar = pkgs.fetchurl {
        url = "https://github.com/pyodide/pyodide/releases/download/${pyodideVersion}/pyodide-${pyodideVersion}.tar.bz2";
        hash = "sha256-MQIRdOj9yVVsF+nUNeINnAfyA6xULZFhyjuNnV0E5+c=";
      };

      svgpathtoolsWheel = pkgs.fetchurl {
        url = "https://files.pythonhosted.org/packages/98/4b/9128c82796479426fba219a5b0da70bbf8f1f0b571a54cc7a420cea0e9c4/svgpathtools-1.7.2-py2.py3-none-any.whl";
        hash = "sha256-7LGIX3xjY74pA/OdhYTtdyvQVaLpIET0PUEngLHUwoM=";
      };

      svgwriteWheel = pkgs.fetchurl {
        url = "https://files.pythonhosted.org/packages/84/15/640e399579024a6875918839454025bb1d5f850bb70d96a11eabb644d11c/svgwrite-1.4.3-py3-none-any.whl";
        hash = "sha256-u2srVFDx7b+ll9kk+awt0JnmJVYuSSAh191hT2X4oi0=";
      };

      python = pkgs.python3.withPackages (ps: with ps; [
        shapely
        svgpathtools
        networkx
        numpy
        scipy
        pytest
      ]);
    in
    {
      packages.x86_64-linux.web = pkgs.stdenv.mkDerivation {
        pname = "cad-svg-web";
        version = "0.1.0";
        src = ./.;

        nativeBuildInputs = [ pkgs.bzip2 pkgs.jq ];

        buildPhase = ''
          mkdir -p pyodide
          tar xjf ${pyodideTar} -C pyodide --strip-components=1
          cp ${svgpathtoolsWheel} pyodide/svgpathtools-1.7.2-py2.py3-none-any.whl
          cp ${svgwriteWheel} pyodide/svgwrite-1.4.3-py3-none-any.whl

          # Patch pyodide-lock.json to remove heavy transitive dependencies
          # networkx pulls in matplotlib, which pulls in pillow, fonttools, etc.
          chmod +w pyodide/pyodide-lock.json
          jq '.packages.networkx.depends |= map(select(. != "matplotlib" and . != "setuptools"))' pyodide/pyodide-lock.json > lock.tmp
          mv lock.tmp pyodide/pyodide-lock.json
        '';

        installPhase = ''
          mkdir -p $out
          cp web/index.html $out/index.html
          cp web/main.js $out/main.js
          cp web/svg_cleaner.js $out/svg_cleaner.js
          cp clean_svg.py $out/clean_svg.py
          cp -r pyodide $out/
        '';
      };

      packages.x86_64-linux.default = self.packages.x86_64-linux.web;

      devShell.x86_64-linux = pkgs.mkShell {
        buildInputs = [
          pkgs.ruff
          python
        ];
      };
    };
}
